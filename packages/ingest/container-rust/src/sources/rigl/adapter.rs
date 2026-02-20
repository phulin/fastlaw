use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::sources::cgs::cross_references::extract_section_cross_references;
use crate::sources::common::{body_block, push_block};
use crate::sources::rigl::parser::{
    normalize_designator, parse_chapter_index, parse_section_detail, parse_title_index,
};
use crate::sources::SourceAdapter;
use crate::types::{DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde_json::json;

pub struct RiglAdapter;

pub const RIGL_ADAPTER: RiglAdapter = RiglAdapter;

#[async_trait]
impl SourceAdapter for RiglAdapter {
    async fn discover(
        &self,
        fetcher: &dyn Fetcher,
        _url: &str,
        manual_start_url: Option<&str>,
    ) -> Result<DiscoveryResult, String> {
        crate::sources::rigl::discover::discover_rigl_root(fetcher, manual_start_url).await
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
                let version_id = &context.build.source_version_id;
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let cache_key = format!(
                    "rigl/{}/title-{}.html",
                    version_id,
                    normalize_designator(title_num)
                );
                let html = context.cache.fetch_cached(url, &cache_key).await?;
                let title = parse_title_index(&html, url)?;
                let title_num = if title_num.is_empty() {
                    title.title_num
                } else {
                    title_num.to_string()
                };
                let title_slug = normalize_designator(&title_num);
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
                            name: Some(title.title_name),
                            path: Some(format!("/title/{title_slug}")),
                            readable_id: Some(title_num.clone()),
                            heading_citation: Some(format!("Title {title_num}")),
                            source_url: Some(url.to_string()),
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
                            "unit_id": metadata["unit_id"],
                            "title_num": title_num,
                            "chapter_num": chapter.chapter_num,
                            "chapter_name_hint": chapter.chapter_name,
                            "sort_order": index as i32
                        }),
                    });
                }
            }
            "chapter" => {
                let version_id = &context.build.source_version_id;
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let title_slug = normalize_designator(title_num);
                let chapter_num_hint = metadata["chapter_num"].as_str().unwrap_or_default();
                let chapter_name_hint = metadata["chapter_name_hint"].as_str().unwrap_or_default();
                let chapter_slug_hint = normalize_designator(chapter_num_hint);
                let cache_key = format!(
                    "rigl/{}/title-{}/chapter-{}.html",
                    version_id, title_slug, chapter_slug_hint
                );
                let html = context.cache.fetch_cached(url, &cache_key).await?;
                let chapter = parse_chapter_index(&html, url)?;
                let chapter_num = if chapter_num_hint.is_empty() {
                    chapter.chapter_num
                } else {
                    chapter_num_hint.to_string()
                };
                let chapter_name = if chapter_name_hint.is_empty() {
                    chapter.chapter_name
                } else {
                    chapter_name_hint.to_string()
                };
                let chapter_slug = normalize_designator(&chapter_num);
                let sort_order = metadata["sort_order"].as_i64().unwrap_or(0) as i32;
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
                            readable_id: Some(chapter_num.clone()),
                            heading_citation: Some(format!("Chapter {chapter_num}")),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                for (index, section) in chapter.sections.into_iter().enumerate() {
                    context.queue.enqueue(QueueItem {
                        url: section.url,
                        parent_id: chapter_id.clone(),
                        level_name: "section".to_string(),
                        level_index: 2,
                        metadata: json!({
                            "unit_id": metadata["unit_id"],
                            "title_num": title_num,
                            "chapter_num": chapter_num,
                            "section_num": section.section_num,
                            "section_name_hint": section.section_name,
                            "sort_order": index as i32
                        }),
                    });
                }
            }
            "section" => {
                let version_id = &context.build.source_version_id;
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let chapter_num = metadata["chapter_num"].as_str().unwrap_or_default();
                let section_num_hint = metadata["section_num"].as_str().unwrap_or_default();
                let sort_order = metadata["sort_order"].as_i64().unwrap_or(0) as i32;
                let title_slug = normalize_designator(title_num);
                let chapter_slug = normalize_designator(chapter_num);
                let section_slug_hint = normalize_designator(section_num_hint);
                let cache_key = format!(
                    "rigl/{}/title-{}/chapter-{}/section-{}.html",
                    version_id, title_slug, chapter_slug, section_slug_hint
                );
                let html = context.cache.fetch_cached(url, &cache_key).await?;
                let parsed = parse_section_detail(&html)?;
                let section_num = if section_num_hint.is_empty() {
                    parsed.section_num
                } else {
                    section_num_hint.to_string()
                };
                let section_slug = normalize_designator(&section_num);
                let section_name_hint = metadata["section_name_hint"].as_str().unwrap_or_default();
                let section_name = if parsed.section_name.is_empty() {
                    section_name_hint.to_string()
                } else {
                    parsed.section_name
                };

                let mut blocks = vec![body_block(&inline_rigl_cross_references(&parsed.body))];
                push_block(
                    &mut blocks,
                    "note",
                    "History",
                    parsed
                        .history
                        .map(|value| inline_rigl_cross_references(&value)),
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
                            id: format!("{}/section-{section_slug}", item.parent_id),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(item.parent_id.clone()),
                            level_name: "section".to_string(),
                            level_index: 2,
                            sort_order,
                            name: Some(section_name),
                            path: Some(format!(
                                "/title/{title_slug}/chapter/{chapter_slug}/section/{section_slug}"
                            )),
                            readable_id: Some(section_num.clone()),
                            heading_citation: Some(format!("R.I. Gen. Laws § {section_num}")),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: Some(serde_json::to_value(&content).unwrap()),
                    })
                    .await?;
            }
            other => return Err(format!("Unknown RIGL level: {other}")),
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
                item.metadata["chapter_num"].as_str().unwrap_or("?")
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

fn inline_rigl_cross_references(text: &str) -> String {
    let mut references = extract_section_cross_references(text);
    references.sort_by(|a, b| b.offset.cmp(&a.offset));

    let mut output = text.to_string();
    for reference in references {
        let Some(link) = rigl_link_from_section_designator(&reference.section) else {
            continue;
        };
        let start = reference.offset;
        let end = start.saturating_add(reference.length);
        if end > output.len()
            || start >= end
            || !output.is_char_boundary(start)
            || !output.is_char_boundary(end)
        {
            continue;
        }
        let label = &output[start..end];
        output.replace_range(start..end, &format!("[{label}]({link})"));
    }
    output
}

fn rigl_link_from_section_designator(section: &str) -> Option<String> {
    let chapter = section.rsplit_once('-')?.0;
    let title = chapter.split('-').next()?;
    let title_slug = normalize_designator(title);
    let chapter_slug = normalize_designator(chapter);
    let section_slug = normalize_designator(section);
    if title_slug.is_empty() || chapter_slug.is_empty() || section_slug.is_empty() {
        return None;
    }
    Some(format!(
        "/title/{title_slug}/chapter/{chapter_slug}/section/{section_slug}"
    ))
}
