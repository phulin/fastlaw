use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::sources::common::body_block;
use crate::sources::mgl::cross_references::inline_section_cross_references;
use crate::sources::mgl::parser::{
    designator_sort_order, normalize_body_text, normalize_designator, parse_chapter_detail,
    parse_part_detail, MglApiChapter, MglApiPart, MglApiSection,
};
use crate::sources::SourceAdapter;
use crate::types::{DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde_json::json;

pub struct MglAdapter;

pub const MGL_ADAPTER: MglAdapter = MglAdapter;

#[async_trait]
impl SourceAdapter for MglAdapter {
    async fn discover(&self, fetcher: &dyn Fetcher, url: &str) -> Result<DiscoveryResult, String> {
        crate::sources::mgl::discover::discover_mgl_root(fetcher, url).await
    }

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String> {
        let url = &item.url;
        let metadata = &item.metadata;
        match item.level_name.as_str() {
            "unit" | "part" => {
                let title_num = metadata["title_num"].as_str().unwrap_or_default();

                let json_str = context
                    .cache
                    .fetch_cached(url, &format!("mgl/part-{}.json", title_num))
                    .await?;
                let part: MglApiPart = serde_json::from_str(&json_str)
                    .map_err(|err| format!("Failed to parse MGL part JSON: {url}: {err}"))?;

                let parsed_part = parse_part_detail(&part, url);

                // Emit part node
                let part_id = format!(
                    "{}/part-{}",
                    context.build.root_node_id,
                    title_num.to_lowercase()
                );
                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: part_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(context.build.root_node_id.to_string()),
                            level_name: "part".to_string(),
                            level_index: 0,
                            sort_order: parsed_part.sort_order,
                            name: Some(parsed_part.part_name.clone()),
                            path: Some(format!("/statutes/mgl/part/{}", title_num.to_lowercase())),
                            readable_id: Some(title_num.to_string()),
                            heading_citation: Some(format!("Part {}", title_num)),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                // Enqueue chapters
                for chapter_summary in &part.Chapters {
                    let chapter_url = chapter_summary.Details.replace("http://", "https://");
                    context.queue.enqueue(QueueItem {
                        url: chapter_url,
                        parent_id: part_id.clone(),
                        level_name: "chapter".to_string(),
                        level_index: 1,
                        metadata: json!({
                            "title_num": title_num,
                            "chapter_code": chapter_summary.Code
                        }),
                    });
                }
            }
            "chapter" => {
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let chapter_code = metadata["chapter_code"].as_str().unwrap_or_default();

                let cache_key = format!("mgl/chapter-{}.json", chapter_code.to_lowercase());
                let json_str = context.cache.fetch_cached(url, &cache_key).await?;
                let chapter: MglApiChapter = serde_json::from_str(&json_str)
                    .map_err(|err| format!("Failed to parse MGL chapter JSON: {url}: {err}"))?;

                let parsed_chapter = parse_chapter_detail(&chapter, url);

                // Emit chapter node
                let chapter_id = format!(
                    "{}/chapter-{}",
                    item.parent_id,
                    parsed_chapter.chapter_code.to_lowercase()
                );
                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: chapter_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(item.parent_id.clone()),
                            level_name: "chapter".to_string(),
                            level_index: 1,
                            sort_order: parsed_chapter.sort_order,
                            name: Some(parsed_chapter.chapter_name.clone()),
                            path: Some(format!(
                                "/statutes/mgl/part/{}/chapter/{}",
                                title_num.to_lowercase(),
                                parsed_chapter.chapter_code.to_lowercase()
                            )),
                            readable_id: Some(parsed_chapter.chapter_code.clone()),
                            heading_citation: Some(format!(
                                "Chapter {}",
                                parsed_chapter.chapter_code
                            )),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                // Enqueue sections
                let mut sections = chapter.Sections.clone();
                sections.sort_by_key(|s| designator_sort_order(&s.Code));

                for (i, section_data) in sections.into_iter().enumerate() {
                    let section_code = normalize_designator(&section_data.Code);
                    let section_url = section_data
                        .Details
                        .as_deref()
                        .unwrap_or(url)
                        .replace("http://", "https://");

                    context.queue.enqueue(QueueItem {
                        url: section_url,
                        parent_id: chapter_id.clone(),
                        level_name: "section".to_string(),
                        level_index: 2,
                        metadata: json!({
                            "title_num": title_num,
                            "chapter_code": parsed_chapter.chapter_code,
                            "section_code": section_code,
                            "sort_order": i as i32,
                            "immediate_text": section_data.Text,
                            "immediate_name": section_data.Name
                        }),
                    });
                }
            }
            "section" => {
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let chapter_code = metadata["chapter_code"].as_str().unwrap_or_default();
                let section_code = metadata["section_code"].as_str().unwrap_or_default();
                let sort_order = metadata["sort_order"].as_i64().unwrap_or(0) as i32;

                let mut raw_body = metadata["immediate_text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let mut section_name_opt =
                    metadata["immediate_name"].as_str().map(|s| s.to_string());

                if raw_body.trim().is_empty() && url != "none" {
                    let cache_key = format!(
                        "mgl/chapter-{}-section-{}.json",
                        chapter_code.to_lowercase(),
                        section_code.to_lowercase()
                    );
                    match context.cache.fetch_cached(url, &cache_key).await {
                        Ok(json_str) => {
                            if let Ok(full_section) =
                                serde_json::from_str::<MglApiSection>(&json_str)
                            {
                                if let Some(text) = full_section.Text {
                                    raw_body = text;
                                }
                                if let Some(name) = full_section.Name {
                                    section_name_opt = Some(name);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to fetch section details for {section_code}: {e}");
                        }
                    }
                }

                let normalized = normalize_body_text(&raw_body);
                let body = inline_section_cross_references(&normalized);

                let blocks = vec![body_block(&body)];

                let content = SectionContent {
                    blocks,
                    metadata: None,
                };
                let section_id =
                    format!("{}/section-{}", item.parent_id, section_code.to_lowercase());
                let heading_citation = format!("MGL c.{} §{}", chapter_code, section_code);
                let section_name = section_name_opt.unwrap_or_else(|| section_code.to_string());

                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: section_id,
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(item.parent_id.clone()),
                            level_name: "section".to_string(),
                            level_index: 2,
                            sort_order,
                            name: Some(section_name),
                            path: Some(format!(
                                "/statutes/mgl/part/{}/chapter/{}/section/{}",
                                title_num.to_lowercase(),
                                chapter_code.to_lowercase(),
                                section_code.to_lowercase()
                            )),
                            readable_id: Some(section_code.to_string()),
                            heading_citation: Some(heading_citation),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: Some(serde_json::to_value(&content).unwrap()),
                    })
                    .await?;
            }
            other => return Err(format!("Unknown MGL level: {other}")),
        }

        Ok(())
    }

    fn unit_label(&self, item: &QueueItem) -> String {
        match item.level_name.as_str() {
            "unit" | "part" => format!(
                "Part {}",
                item.metadata["title_num"].as_str().unwrap_or("?")
            ),
            "chapter" => format!(
                "Chapter {}",
                item.metadata["chapter_code"].as_str().unwrap_or("?")
            ),
            "section" => format!(
                "Section {}",
                item.metadata["section_code"].as_str().unwrap_or("?")
            ),
            other => other.to_string(),
        }
    }
    fn needs_zip_extraction(&self) -> bool {
        false
    }
}
