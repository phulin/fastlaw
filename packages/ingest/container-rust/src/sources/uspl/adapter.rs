use crate::runtime::types::{Cache, IngestContext, QueueItem};
use crate::sources::uspl::discover::{discover_uspl_root, VolumeMetadata};
use crate::sources::uspl::markdown::law_to_markdown;
use crate::sources::uspl::parser::parse_uslm_volume;
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;

// govinfo.gov: 40 req/sec hard limit. Use 33 req/sec to stay safely under.
const GOVINFO_THROTTLE_RPS: u32 = 33;

pub struct UsplAdapter;

pub const USPL_ADAPTER: UsplAdapter = UsplAdapter;

#[async_trait]
impl SourceAdapter for UsplAdapter {
    async fn discover(
        &self,
        cache: &dyn Cache,
        url: &str,
        manual_start_url: Option<&str>,
    ) -> Result<DiscoveryResult, String> {
        let api_key = manual_start_url.unwrap_or_default();
        discover_uspl_root(cache, url, api_key).await
    }

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String> {
        match item.level_name.as_str() {
            "volume" => process_volume(context, item).await,
            other => Err(format!("Unknown USPL level: {other}")),
        }
    }

    fn unit_label(&self, item: &QueueItem) -> String {
        let pkg = item.metadata["title_num"]
            .as_str()
            .and_then(|s| s.split('|').next())
            .unwrap_or("?");
        format!("Volume {}", pkg)
    }
}

async fn process_volume(context: &mut IngestContext<'_>, item: &QueueItem) -> Result<(), String> {
    let accessed_at = context.build.accessed_at.to_string();
    let source_version_id = context.build.source_version_id.to_string();
    let root_node_id = context.build.root_node_id.to_string();

    let title_num = item.metadata["title_num"].as_str().unwrap_or_default();
    let meta = VolumeMetadata::parse(title_num)
        .ok_or_else(|| format!("Failed to parse volume metadata: {title_num}"))?;

    // ── Incremental re-ingest check ──────────────────────────────────────────
    // The cache proxy stores USLM XML at the key below. If the key exists the
    // proxy returns the cached bytes and never hits govinfo again. We still
    // parse every time (fast), so every ingest produces a complete source_version.
    let cache_key = format!("uspl/{}/uslm.xml", meta.package_id);
    let xml = context
        .cache
        .fetch_cached(&item.url, &cache_key, Some(GOVINFO_THROTTLE_RPS))
        .await?;

    // ── Congress node (INSERT OR IGNORE semantics in worker) ─────────────────
    let congress_node_id = format!("{}/congress-{}", root_node_id, meta.congress);
    context
        .nodes
        .insert_node(NodePayload {
            meta: NodeMeta {
                id: congress_node_id.clone(),
                source_version_id: source_version_id.clone(),
                parent_id: Some(root_node_id.clone()),
                level_name: "congress".to_string(),
                level_index: 0,
                sort_order: meta.congress as i32,
                name: Some(format!(
                    "{}th Congress ({})",
                    meta.congress,
                    congress_years(meta.congress)
                )),
                path: Some(format!("/{}", meta.congress)),
                readable_id: Some(format!("{}th Congress", meta.congress)),
                heading_citation: Some(format!("{}th Congress", meta.congress)),
                source_url: Some(format!(
                    "https://www.govinfo.gov/app/collection/statute/{}",
                    meta.congress
                )),
                accessed_at: Some(accessed_at.clone()),
            },
            content: None,
        })
        .await?;

    // ── Parse USLM and emit one node per public law ──────────────────────────
    let mut law_sort_order: i32 = 0;
    let mut errors: Vec<String> = Vec::new();

    // Collect laws first (parse_uslm_volume is synchronous)
    let mut laws = Vec::new();
    parse_uslm_volume(&xml, |law| {
        laws.push(law);
    });

    for law in laws {
        if law.congress == 0 || law.public_law_number.starts_with("0-") {
            continue;
        }

        // Parse law number from "congress-lawnum" format
        let law_num = law
            .public_law_number
            .split('-')
            .nth(1)
            .unwrap_or(&law.public_law_number)
            .to_string();

        let law_node_id = format!("{}/pl-{}", congress_node_id, law_num);
        let readable_id = format!("Pub. L. {}", law.public_law_number);
        let heading_citation = if !law.stat_citation.is_empty() {
            format!("{}, {}", readable_id, law.stat_citation)
        } else {
            readable_id.clone()
        };

        // Build govinfo source URL from package_id and stat page
        let source_url = if !law.source_page.is_empty() {
            // source_page is like "/us/stat/N/P"
            let page_part = law
                .source_page
                .rsplit('/')
                .next()
                .unwrap_or("")
                .replace("Pg", "Pg");
            format!(
                "https://www.govinfo.gov/app/details/{}/{}-Pg{}",
                meta.package_id, meta.package_id, page_part
            )
        } else {
            format!("https://www.govinfo.gov/app/details/{}/", meta.package_id)
        };

        let markdown = law_to_markdown(&law);
        let content = SectionContent {
            blocks: vec![ContentBlock {
                type_: "body".to_string(),
                content: if markdown.is_empty() {
                    None
                } else {
                    Some(markdown)
                },
                label: None,
            }],
            metadata: None,
        };

        match context
            .nodes
            .insert_node(NodePayload {
                meta: NodeMeta {
                    id: law_node_id,
                    source_version_id: source_version_id.clone(),
                    parent_id: Some(congress_node_id.clone()),
                    level_name: "law".to_string(),
                    level_index: 1,
                    sort_order: law_sort_order,
                    name: Some(format!(
                        "Public Law {} — {}",
                        law.public_law_number, law.official_title
                    )),
                    path: Some(format!("/{}/{}", law.congress, law_num)),
                    readable_id: Some(readable_id),
                    heading_citation: Some(heading_citation),
                    source_url: Some(source_url),
                    accessed_at: Some(accessed_at.clone()),
                },
                content: Some(serde_json::to_value(&content).unwrap()),
            })
            .await
        {
            Ok(()) => {
                law_sort_order += 1;
            }
            Err(e) => {
                errors.push(format!("PL {}: {e}", law.public_law_number));
            }
        }
    }

    if !errors.is_empty() {
        eprintln!(
            "[USPL] {} errors in {}: {}",
            errors.len(),
            meta.package_id,
            errors.join("; ")
        );
    }

    Ok(())
}

/// Format the year range for a congress (approximate).
fn congress_years(congress: u32) -> String {
    // 1st Congress = 1789. Each congress is 2 years.
    let start = 1787 + congress as u32 * 2;
    format!("{}–{}", start, start + 1)
}
