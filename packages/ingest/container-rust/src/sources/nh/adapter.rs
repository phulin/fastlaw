use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::sources::common::{body_block, push_block};
use crate::sources::nh::parser::{
    inline_nh_cross_references, normalize_designator, parse_chapter_index,
    parse_merged_chapter_sections, parse_section_detail, parse_title_index,
};
use crate::sources::SourceAdapter;
use crate::types::{DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde_json::json;

pub struct NhAdapter;

pub const NH_ADAPTER: NhAdapter = NhAdapter;

#[async_trait]
impl SourceAdapter for NhAdapter {
    async fn discover(
        &self,
        fetcher: &dyn Fetcher,
        _url: &str,
        manual_start_url: Option<&str>,
    ) -> Result<DiscoveryResult, String> {
        crate::sources::nh::discover::discover_nh_root(fetcher, manual_start_url).await
    }

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String> {
        match item.level_name.as_str() {
            "unit" | "title" => {
                let title_num = item.metadata["title_num"].as_str().unwrap_or_default();
                let title_slug = normalize_designator(title_num);
                let cache_key = format!(
                    "nh/{}/title-{title_slug}.html",
                    context.build.source_version_id
                );
                let html = context.cache.fetch_cached(&item.url, &cache_key).await?;
                let title = parse_title_index(&html, &item.url)?;
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
                            heading_citation: Some(format!("Title {}", title.title_num)),
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
                            "title_num": title.title_num,
                            "chapter_num": chapter.chapter_num,
                            "chapter_name_hint": chapter.chapter_name,
                            "sort_order": index as i32
                        }),
                    });
                }
            }
            "chapter" => {
                let title_num = item.metadata["title_num"].as_str().unwrap_or_default();
                let title_slug = normalize_designator(title_num);
                let chapter_num = item.metadata["chapter_num"].as_str().unwrap_or_default();
                let chapter_slug = normalize_designator(chapter_num);
                let chapter_name_hint = item.metadata["chapter_name_hint"]
                    .as_str()
                    .map(ToString::to_string)
                    .unwrap_or_default();
                let sort_order = item.metadata["sort_order"].as_i64().unwrap_or(0) as i32;
                let cache_key = format!(
                    "nh/{}/title-{title_slug}/chapter-{chapter_slug}.html",
                    context.build.source_version_id
                );
                let chapter_html = context.cache.fetch_cached(&item.url, &cache_key).await?;
                let chapter = parse_chapter_index(&chapter_html, &item.url)?;
                let chapter_name = if chapter.chapter_name.is_empty() {
                    chapter_name_hint
                } else {
                    chapter.chapter_name.clone()
                };
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
                            readable_id: Some(chapter.chapter_num.clone()),
                            heading_citation: Some(format!("Chapter {}", chapter.chapter_num)),
                            source_url: Some(item.url.clone()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                if chapter.sections.is_empty() {
                    let merged_url = derive_merged_url(title_num, &chapter.chapter_num);
                    let merged_cache_key = format!(
                        "nh/{}/title-{title_slug}/chapter-{chapter_slug}-mrg.html",
                        context.build.source_version_id
                    );
                    let merged_html = context
                        .cache
                        .fetch_cached(&merged_url, &merged_cache_key)
                        .await?;
                    let sections = parse_merged_chapter_sections(&merged_html)?;
                    for (index, section) in sections.into_iter().enumerate() {
                        insert_section_node(
                            context,
                            &chapter_id,
                            title_num,
                            &chapter.chapter_num,
                            &merged_url,
                            index as i32,
                            section,
                        )
                        .await?;
                    }
                } else {
                    for (index, section) in chapter.sections.into_iter().enumerate() {
                        context.queue.enqueue(QueueItem {
                            url: section.url,
                            parent_id: chapter_id.clone(),
                            level_name: "section".to_string(),
                            level_index: 2,
                            metadata: json!({
                                "unit_id": item.metadata["unit_id"],
                                "title_num": title_num,
                                "chapter_num": chapter.chapter_num,
                                "section_num": section.section_num,
                                "section_name_hint": section.section_name,
                                "sort_order": index as i32
                            }),
                        });
                    }
                }
            }
            "section" => {
                let title_num = item.metadata["title_num"].as_str().unwrap_or_default();
                let chapter_num = item.metadata["chapter_num"].as_str().unwrap_or_default();
                let section_num = item.metadata["section_num"].as_str().unwrap_or_default();
                let sort_order = item.metadata["sort_order"].as_i64().unwrap_or(0) as i32;
                let title_slug = normalize_designator(title_num);
                let chapter_slug = normalize_designator(chapter_num);
                let section_slug = normalize_designator(section_num);
                let cache_key = format!(
                    "nh/{}/title-{title_slug}/chapter-{chapter_slug}/section-{section_slug}.html",
                    context.build.source_version_id
                );
                let html = context.cache.fetch_cached(&item.url, &cache_key).await?;
                let parsed = parse_section_detail(&html)?;
                let mut section = parsed.clone();
                if section.section_name == section.section_num {
                    section.section_name = item.metadata["section_name_hint"]
                        .as_str()
                        .unwrap_or(section_num)
                        .to_string();
                }
                insert_section_node(
                    context,
                    &item.parent_id,
                    title_num,
                    chapter_num,
                    &item.url,
                    sort_order,
                    section,
                )
                .await?;
            }
            other => return Err(format!("Unknown NH level: {other}")),
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

async fn insert_section_node(
    context: &mut IngestContext<'_>,
    chapter_id: &str,
    title_num: &str,
    chapter_num: &str,
    source_url: &str,
    sort_order: i32,
    section: crate::sources::nh::parser::NhSectionDetail,
) -> Result<(), String> {
    let title_slug = normalize_designator(title_num);
    let chapter_slug = normalize_designator(chapter_num);
    let section_slug = normalize_designator(&section.section_num);
    let section_path = format!("/title/{title_slug}/chapter/{chapter_slug}/section/{section_slug}");

    let body = inline_nh_cross_references(&section.body, title_num);
    let mut blocks = vec![body_block(&body)];
    push_block(
        &mut blocks,
        "note",
        "Source",
        section
            .source_note
            .as_ref()
            .map(|note| inline_nh_cross_references(note, title_num)),
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
                parent_id: Some(chapter_id.to_string()),
                level_name: "section".to_string(),
                level_index: 2,
                sort_order,
                name: Some(section.section_name.clone()),
                path: Some(section_path),
                readable_id: Some(section.section_num.clone()),
                heading_citation: Some(format!("N.H. Rev. Stat. § {}", section.section_num)),
                source_url: Some(source_url.to_string()),
                accessed_at: Some(context.build.accessed_at.to_string()),
            },
            content: Some(serde_json::to_value(&content).unwrap()),
        })
        .await
}

fn derive_merged_url(title_num: &str, chapter_num: &str) -> String {
    format!("https://gc.nh.gov/rsa/html/{title_num}/{chapter_num}/{chapter_num}-mrg.htm")
}
