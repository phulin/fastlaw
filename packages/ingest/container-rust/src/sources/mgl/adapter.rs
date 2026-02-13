use crate::runtime::types::IngestContext;
use crate::sources::mgl::cross_references::inline_section_cross_references;
use crate::sources::mgl::parser::{
    designator_sort_order, normalize_body_text, normalize_designator, parse_chapter_detail,
    parse_part_detail, parse_section_content, MglApiChapter, MglApiPart, MglApiSection,
};
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde_json::json;

pub struct MglAdapter;

pub const MGL_ADAPTER: MglAdapter = MglAdapter;

const SECTION_LEVEL_INDEX: i32 = 2;

#[async_trait]
impl SourceAdapter for MglAdapter {
    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        url: &str,
        metadata: serde_json::Value,
    ) -> Result<(), String> {
        let task_type = metadata["type"].as_str().unwrap_or("unit");
        match task_type {
            "discovery" => {
                let fetcher = crate::runtime::fetcher::HttpFetcher::new(reqwest::Client::new());
                let discovery =
                    crate::sources::mgl::discover::discover_mgl_root(&fetcher, url).await?;

                // Enqueue units (parts)
                for (i, root) in discovery.unit_roots.into_iter().enumerate() {
                    context.queue.enqueue(
                        root.url,
                        json!({
                            "type": "unit",
                            "unit_id": root.id,
                            "title_num": root.title_num,
                            "sort_order": i as i32
                        }),
                    );
                }

                // Report discovery results to orchestrator via a special "node" or metadata?
                // For now, enqueuing a special record that the orchestrator can recognize.
                context.queue.enqueue(
                    "discovery-result".to_string(),
                    json!({
                        "type": "discovery_result",
                        "version_id": discovery.version_id,
                        "root_node": discovery.root_node,
                    }),
                );
            }
            "unit" | "part" => {
                let title_num = metadata["title_num"]
                    .as_str()
                    .or_else(|| metadata["payload"]["titleNum"].as_str())
                    .unwrap_or_default();
                let _sort_order = metadata["sort_order"].as_i64().unwrap_or(0) as i32;

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
                    context.queue.enqueue(
                        chapter_url,
                        json!({
                            "type": "chapter",
                            "parent_id": part_id,
                            "title_num": title_num,
                            "chapter_code": chapter_summary.Code
                        }),
                    );
                }
            }
            "chapter" => {
                let parent_id = metadata["parent_id"].as_str().unwrap_or_default();
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
                    parent_id,
                    parsed_chapter.chapter_code.to_lowercase()
                );
                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: chapter_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(parent_id.to_string()),
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

                    context.queue.enqueue(
                        section_url,
                        json!({
                            "type": "section",
                            "parent_id": chapter_id,
                            "title_num": title_num,
                            "chapter_code": parsed_chapter.chapter_code,
                            "section_code": section_code,
                            "sort_order": i as i32,
                            "immediate_text": section_data.Text,
                            "immediate_name": section_data.Name
                        }),
                    );
                }
            }
            "section" => {
                let parent_id = metadata["parent_id"].as_str().unwrap_or_default();
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

                let blocks = vec![ContentBlock {
                    type_: "body".to_string(),
                    label: None,
                    content: if body.trim().is_empty() {
                        None
                    } else {
                        Some(body)
                    },
                }];

                let content = SectionContent {
                    blocks,
                    metadata: None,
                };
                let section_id = format!("{}/section-{}", parent_id, section_code.to_lowercase());
                let heading_citation = format!("MGL c.{} §{}", chapter_code, section_code);
                let section_name = section_name_opt.unwrap_or_else(|| section_code.to_string());

                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: section_id,
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(parent_id.to_string()),
                            level_name: "section".to_string(),
                            level_index: SECTION_LEVEL_INDEX,
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
            _ => return Err(format!("Unknown MGL task type: {task_type}")),
        }

        Ok(())
    }

    fn unit_label(&self, metadata: &serde_json::Value) -> String {
        let task_type = metadata["type"].as_str().unwrap_or("unknown");
        match task_type {
            "part" => format!("Part {}", metadata["title_num"].as_str().unwrap_or("?")),
            "chapter" => format!(
                "Chapter {}",
                metadata["chapter_code"].as_str().unwrap_or("?")
            ),
            "section" => format!(
                "Section {}",
                metadata["section_code"].as_str().unwrap_or("?")
            ),
            _ => task_type.to_string(),
        }
    }
    fn needs_zip_extraction(&self) -> bool {
        false
    }
}

/// Process a single section with full content
pub fn process_section_content(
    section: &MglApiSection,
    chapter_code: &str,
    part_code: &str,
    parent_id: &str,
    source_version_id: &str,
    accessed_at: &str,
    sort_order: i32,
) -> Result<NodePayload, String> {
    let parsed = parse_section_content(section);
    let body = inline_section_cross_references(&parsed.body);

    let blocks = vec![ContentBlock {
        type_: "body".to_string(),
        label: None,
        content: if body.trim().is_empty() {
            None
        } else {
            Some(body)
        },
    }];

    let content = SectionContent {
        blocks,
        metadata: None,
    };

    let section_id = format!("{}/section-{}", parent_id, section.Code.to_lowercase());

    let heading_citation = format!("MGL c.{} §{}", chapter_code, section.Code);

    Ok(NodePayload {
        meta: NodeMeta {
            id: section_id,
            source_version_id: source_version_id.to_string(),
            parent_id: Some(parent_id.to_string()),
            level_name: "section".to_string(),
            level_index: SECTION_LEVEL_INDEX,
            sort_order,
            name: Some(parsed.heading),
            path: Some(format!(
                "/statutes/mgl/part/{}/chapter/{}/section/{}",
                part_code.to_lowercase(),
                chapter_code.to_lowercase(),
                section.Code.to_lowercase()
            )),
            readable_id: Some(section.Code.clone()),
            heading_citation: Some(heading_citation),
            source_url: Some(format!(
                "https://malegislature.gov/Laws/GeneralLaws/Part{}/Chapter{}/Section{}",
                part_code, chapter_code, section.Code
            )),
            accessed_at: Some(accessed_at.to_string()),
        },
        content: Some(serde_json::to_value(&content).unwrap()),
    })
}
