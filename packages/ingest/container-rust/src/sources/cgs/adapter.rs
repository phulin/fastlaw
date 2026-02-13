use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::sources::cgs::cross_references::inline_section_cross_references;
use crate::sources::cgs::discover::{
    extract_chapter_urls, extract_title_name_from_html, parse_chapter_id_from_url,
};
use crate::sources::cgs::parser::{
    designator_sort_order, normalize_designator, parse_cgs_chapter_html, CgsUnitKind,
};
use crate::sources::common::{body_block, capitalize_first, push_block};
use crate::sources::SourceAdapter;
use crate::types::{DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde_json::json;

pub struct CgsAdapter;

pub const CGS_ADAPTER: CgsAdapter = CgsAdapter;

#[async_trait]
impl SourceAdapter for CgsAdapter {
    async fn discover(&self, fetcher: &dyn Fetcher, url: &str) -> Result<DiscoveryResult, String> {
        crate::sources::cgs::discover::discover_cgs_root(fetcher, url).await
    }

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String> {
        let url = &item.url;
        let metadata = &item.metadata;

        match item.level_name.as_str() {
            "unit" | "title" => {
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let normalized_title_id =
                    normalize_designator(Some(title_num)).unwrap_or_else(|| title_num.to_string());

                let cache_key = format!("cgs/title_{normalized_title_id}.html");
                let html = context.cache.fetch_cached(url, &cache_key).await?;

                let title_name = extract_title_name_from_html(&html)
                    .unwrap_or_else(|| format!("Title {normalized_title_id}"));

                // Emit title node
                let title_id =
                    format!("{}/title-{normalized_title_id}", context.build.root_node_id);
                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: title_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(context.build.root_node_id.to_string()),
                            level_name: "title".to_string(),
                            level_index: 0,
                            sort_order: designator_sort_order(&normalized_title_id),
                            name: Some(title_name),
                            path: Some(format!("/statutes/cgs/title/{normalized_title_id}")),
                            readable_id: Some(normalized_title_id.clone()),
                            heading_citation: Some(format!("Title {normalized_title_id}")),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                // Extract chapter URLs and enqueue them
                let chapter_urls = extract_chapter_urls(&html, url)?;
                for (i, chapter) in chapter_urls.into_iter().enumerate() {
                    context.queue.enqueue(QueueItem {
                        url: chapter.url,
                        parent_id: title_id.clone(),
                        level_name: chapter.unit_kind.as_str().to_string(),
                        level_index: 1,
                        metadata: json!({
                            "title_num": normalized_title_id,
                            "chapter_id": chapter.chapter_id,
                            "unit_id": metadata["unit_id"],
                            "sort_order": i as i32
                        }),
                    });
                }
            }
            "chapter" | "article" => {
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let normalized_title_id =
                    normalize_designator(Some(title_num)).unwrap_or_else(|| title_num.to_string());

                let chapter_id = metadata["chapter_id"]
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| parse_chapter_id_from_url(url))
                    .unwrap_or_default();

                let unit_kind = CgsUnitKind::from_url(url);

                let cache_key = format!("cgs/{}.html", chapter_id);
                let html = context.cache.fetch_cached(url, &cache_key).await?;

                let parsed = parse_cgs_chapter_html(&html, &chapter_id, url, unit_kind);

                // Emit chapter node
                let chapter_string_id = format!(
                    "{}/{kind}-{id}",
                    item.parent_id,
                    kind = unit_kind.as_str(),
                    id = chapter_id
                );
                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: chapter_string_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(item.parent_id.clone()),
                            level_name: unit_kind.as_str().to_string(),
                            level_index: 1,
                            sort_order: designator_sort_order(&chapter_id),
                            name: parsed.chapter_title.clone(),
                            path: Some(format!(
                                "/statutes/cgs/{}/{}/{}",
                                unit_kind.as_str(),
                                normalized_title_id,
                                chapter_id
                            )),
                            readable_id: Some(chapter_id.clone()),
                            heading_citation: Some(format!(
                                "{} {}",
                                capitalize_first(unit_kind.as_str()),
                                chapter_id
                            )),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                for section in parsed.sections {
                    let body = inline_section_cross_references(&section.body);
                    let mut blocks = vec![body_block(&body)];

                    let inline_refs = |s: &str| inline_section_cross_references(s);
                    push_block(
                        &mut blocks,
                        "history_short",
                        "Short History",
                        section.history_short,
                        None,
                    );
                    push_block(
                        &mut blocks,
                        "history_long",
                        "Long History",
                        section.history_long,
                        None,
                    );
                    push_block(
                        &mut blocks,
                        "citations",
                        "Citations",
                        section.citations,
                        None,
                    );
                    push_block(
                        &mut blocks,
                        "see_also",
                        "See Also",
                        section.see_also,
                        Some(&inline_refs),
                    );

                    let content = SectionContent {
                        blocks,
                        metadata: None,
                    };
                    let section_slug = section
                        .string_id
                        .split('/')
                        .next_back()
                        .ok_or("Invalid section string id")?
                        .to_string();

                    context
                        .nodes
                        .insert_node(NodePayload {
                            meta: NodeMeta {
                                id: format!("{chapter_string_id}/section-{section_slug}"),
                                source_version_id: context.build.source_version_id.to_string(),
                                parent_id: Some(chapter_string_id.clone()),
                                level_name: section.level_name,
                                level_index: section.level_index,
                                sort_order: section.sort_order,
                                name: section.name,
                                path: Some(section.path),
                                readable_id: Some(section.readable_id.clone()),
                                heading_citation: Some(format!("CGS § {}", section.readable_id)),
                                source_url: Some(section.source_url),
                                accessed_at: Some(context.build.accessed_at.to_string()),
                            },
                            content: Some(serde_json::to_value(&content).unwrap()),
                        })
                        .await?;
                }
            }
            other => return Err(format!("Unknown CGS level: {other}")),
        }

        Ok(())
    }

    fn unit_label(&self, item: &QueueItem) -> String {
        match item.level_name.as_str() {
            "unit" | "title" => format!(
                "Title {}",
                item.metadata["title_num"].as_str().unwrap_or("?")
            ),
            "chapter" | "article" => format!(
                "{} {}",
                capitalize_first(&item.level_name),
                item.metadata["chapter_id"].as_str().unwrap_or("?")
            ),
            other => other.to_string(),
        }
    }
}
