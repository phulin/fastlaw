use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::sources::common::{body_block, push_block};
use crate::sources::vt::discover::title_display_num_from_code;
use crate::sources::vt::parser::{
    inline_section_cross_references, normalize_designator, parse_fullchapter_detail,
    parse_title_index,
};
use crate::sources::SourceAdapter;
use crate::types::{DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde_json::json;

pub struct VtAdapter;

pub const VT_ADAPTER: VtAdapter = VtAdapter;

#[async_trait]
impl SourceAdapter for VtAdapter {
    async fn discover(
        &self,
        fetcher: &dyn Fetcher,
        _url: &str,
        manual_start_url: Option<&str>,
    ) -> Result<DiscoveryResult, String> {
        crate::sources::vt::discover::discover_vt_root(fetcher, manual_start_url).await
    }

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String> {
        match item.level_name.as_str() {
            "unit" | "title" => {
                let title_num = item.metadata["title_num"].as_str().unwrap_or_default();
                let cache_key = format!(
                    "vt/{}/title-{}.html",
                    context.build.source_version_id,
                    title_num.to_ascii_lowercase()
                );
                let html = context.cache.fetch_cached(&item.url, &cache_key).await?;
                let title = parse_title_index(&html, &item.url)?;
                let title_num_for_chapters = title.title_num.clone();
                let title_display_num_for_chapters = title.title_display_num.clone();
                let title_slug = normalize_designator(&title.title_num);
                let title_id = format!("{}/title-{title_slug}", context.build.root_node_id);

                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: title_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(context.build.root_node_id.to_string()),
                            level_name: "title".to_string(),
                            level_index: 0,
                            sort_order: context.build.unit_sort_order,
                            name: Some(title.title_name.clone()),
                            path: Some(format!("/title/{title_slug}")),
                            readable_id: Some(title.title_num.clone()),
                            heading_citation: Some(format!("Title {}", title.title_display_num)),
                            source_url: Some(item.url.clone()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                for (index, chapter) in title.chapters.into_iter().enumerate() {
                    context.queue.enqueue(QueueItem {
                        url: chapter.url,
                        parent_id: title_id.clone(),
                        level_name: "chapter".to_string(),
                        level_index: 1,
                        metadata: json!({
                            "unit_id": item.metadata["unit_id"],
                            "title_num": title_num_for_chapters,
                            "title_display_num": title_display_num_for_chapters,
                            "chapter_num": chapter.chapter_num,
                            "chapter_display_num": chapter.chapter_display_num,
                            "chapter_name_hint": chapter.chapter_name,
                            "fullchapter_url": chapter.fullchapter_url,
                            "sort_order": index as i32
                        }),
                    });
                }
            }
            "chapter" => {
                let title_num = item.metadata["title_num"].as_str().unwrap_or_default();
                let title_display_num = item.metadata["title_display_num"]
                    .as_str()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| title_display_num_from_code(title_num));
                let chapter_num = item.metadata["chapter_num"].as_str().unwrap_or_default();
                let chapter_display_num = item.metadata["chapter_display_num"]
                    .as_str()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| chapter_num.trim_start_matches('0').to_string());
                let fullchapter_url = item.metadata["fullchapter_url"]
                    .as_str()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        derive_fullchapter_url(&item.url).unwrap_or_else(|_| item.url.clone())
                    });
                let sort_order = item.metadata["sort_order"].as_i64().unwrap_or(0) as i32;
                let cache_key = format!(
                    "vt/{}/fullchapter-{title_num}-{chapter_num}.html",
                    context.build.source_version_id
                );
                let html = context
                    .cache
                    .fetch_cached(&fullchapter_url, &cache_key)
                    .await?;
                let parsed =
                    parse_fullchapter_detail(&html, &title_display_num, &chapter_display_num)?;
                let chapter_name_hint = item.metadata["chapter_name_hint"]
                    .as_str()
                    .map(ToString::to_string)
                    .unwrap_or_default();
                let chapter_name = if parsed.chapter_name.is_empty() {
                    if chapter_name_hint.is_empty() {
                        chapter_display_num.clone()
                    } else {
                        chapter_name_hint
                    }
                } else {
                    parsed.chapter_name.clone()
                };
                let title_slug = normalize_designator(title_num);
                let chapter_slug = normalize_designator(chapter_num);
                let chapter_id = format!("{}/chapter-{chapter_slug}", item.parent_id);

                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: chapter_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(item.parent_id.clone()),
                            level_name: "chapter".to_string(),
                            level_index: 1,
                            sort_order,
                            name: Some(chapter_name),
                            path: Some(format!("/title/{title_slug}/chapter/{chapter_slug}")),
                            readable_id: Some(chapter_display_num.clone()),
                            heading_citation: Some(format!("Chapter {chapter_display_num}")),
                            source_url: Some(item.url.clone()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                for (index, section) in parsed.sections.into_iter().enumerate() {
                    let section_num = section.section_num.clone();
                    let section_slug = normalize_designator(&section.section_num);
                    let section_url = format!(
                        "https://legislature.vermont.gov/statutes/section/{}/{}/{}",
                        title_num.to_ascii_lowercase(),
                        chapter_num.to_ascii_lowercase(),
                        section.section_num.to_ascii_lowercase()
                    );
                    let body =
                        inline_section_cross_references(&section.body, title_num, chapter_num);
                    let mut blocks = vec![body_block(&body)];
                    push_block(
                        &mut blocks,
                        "note",
                        "History",
                        section.history.map(|history| {
                            inline_section_cross_references(&history, title_num, chapter_num)
                        }),
                        None,
                    );
                    let content = SectionContent {
                        blocks,
                        metadata: None,
                    };

                    context
                        .nodes
                        .insert_node(NodePayload {
                            meta: NodeMeta {
                                id: format!("{chapter_id}/section-{section_slug}"),
                                source_version_id: context.build.source_version_id.to_string(),
                                parent_id: Some(chapter_id.clone()),
                                level_name: "section".to_string(),
                                level_index: 2,
                                sort_order: index as i32,
                                name: Some(section.section_name),
                                path: Some(format!(
                                    "/title/{title_slug}/chapter/{chapter_slug}/section/{section_slug}"
                                )),
                                readable_id: Some(section_num.clone()),
                                heading_citation: Some(format!(
                                    "Vt. Stat. tit. {title_display_num} § {section_num}"
                                )),
                                source_url: Some(section_url),
                                accessed_at: Some(context.build.accessed_at.to_string()),
                            },
                            content: Some(serde_json::to_value(&content).unwrap()),
                        })
                        .await?;
                }
            }
            other => return Err(format!("Unknown VT level: {other}")),
        }

        Ok(())
    }

    fn unit_label(&self, item: &QueueItem) -> String {
        match item.level_name.as_str() {
            "unit" | "title" => format!(
                "Title {}",
                item.metadata["title_num"].as_str().unwrap_or("?")
            ),
            "chapter" => format!(
                "Chapter {}",
                item.metadata["chapter_display_num"].as_str().unwrap_or("?")
            ),
            "section" => format!(
                "Section {}",
                item.metadata["section_num"].as_str().unwrap_or("?")
            ),
            other => other.to_string(),
        }
    }

    fn needs_zip_extraction(&self) -> bool {
        false
    }
}

fn derive_fullchapter_url(chapter_url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(chapter_url)
        .map_err(|e| format!("Invalid chapter URL `{chapter_url}`: {e}"))?;
    crate::sources::vt::parser::chapter_to_fullchapter_url(&parsed)
}
