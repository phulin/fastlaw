use crate::runtime::types::IngestContext;
use crate::sources::mgl::cross_references::inline_section_cross_references;
use crate::sources::mgl::parser::{
    designator_sort_order, normalize_body_text, normalize_designator, parse_chapter_detail,
    parse_part_detail, parse_section_content, MglApiChapter, MglApiPart, MglApiSection,
};
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, NodeMeta, NodePayload, SectionContent, UnitEntry};
use async_trait::async_trait;
use serde::Deserialize;

pub struct MglAdapter;

pub const MGL_ADAPTER: MglAdapter = MglAdapter;

const SECTION_LEVEL_INDEX: i32 = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MglUnitPayload {
    title_num: String,
}

#[async_trait]
impl SourceAdapter for MglAdapter {
    async fn discover(
        &self,
        client: &reqwest::Client,
        download_base: &str,
    ) -> Result<crate::types::DiscoveryResult, String> {
        crate::sources::mgl::discover::discover_mgl_root(client, download_base).await
    }

    async fn process_unit(
        &self,
        unit: &UnitEntry,
        context: &mut IngestContext<'_>,
        json: &str,
    ) -> Result<(), String> {
        let payload: MglUnitPayload = serde_json::from_value(unit.payload.clone())
            .map_err(|err| format!("Invalid MGL unit payload for {}: {err}", unit.unit_id))?;

        // Parse the part JSON
        let part: MglApiPart = serde_json::from_str(json)
            .map_err(|err| format!("Failed to parse MGL part JSON: {}: {err}", unit.url))?;

        let parsed_part = parse_part_detail(&part, &unit.url);

        // Emit part node
        let part_id = format!(
            "{}/part-{}",
            context.build.root_node_id,
            payload.title_num.to_lowercase()
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
                    path: Some(format!(
                        "/statutes/mgl/part/{}",
                        payload.title_num.to_lowercase()
                    )),
                    readable_id: Some(format!("Part {}", payload.title_num)),
                    heading_citation: Some(format!("Part {}", payload.title_num)),
                    source_url: Some(unit.url.clone()),
                    accessed_at: Some(context.build.accessed_at.to_string()),
                },
                content: None,
            })
            .await?;

        // Process each chapter in the part
        for chapter_summary in &part.Chapters {
            // Fetch chapter details from API
            let chapter_url = chapter_summary.Details.replace("http://", "https://");

            let chapter_json = context
                .cache
                .fetch_cached(&chapter_url, None)
                .await
                .map_err(|err| {
                    format!("Failed to fetch chapter {}: {err}", chapter_summary.Code)
                })?;

            let chapter: MglApiChapter = serde_json::from_str(&chapter_json).map_err(|err| {
                format!(
                    "Failed to parse chapter {} JSON: {err}",
                    chapter_summary.Code
                )
            })?;

            let parsed_chapter = parse_chapter_detail(&chapter, &chapter_url);

            // Emit chapter node
            let chapter_id = format!(
                "{}/chapter-{}",
                part_id,
                parsed_chapter.chapter_code.to_lowercase()
            );
            context
                .nodes
                .insert_node(NodePayload {
                    meta: NodeMeta {
                        id: chapter_id.clone(),
                        source_version_id: context.build.source_version_id.to_string(),
                        parent_id: Some(part_id.clone()),
                        level_name: "chapter".to_string(),
                        level_index: 1,
                        sort_order: parsed_chapter.sort_order,
                        name: Some(parsed_chapter.chapter_name.clone()),
                        path: Some(format!(
                            "/statutes/mgl/part/{}/chapter/{}",
                            payload.title_num.to_lowercase(),
                            parsed_chapter.chapter_code.to_lowercase()
                        )),
                        readable_id: Some(format!("Chapter {}", parsed_chapter.chapter_code)),
                        heading_citation: Some(format!("Chapter {}", parsed_chapter.chapter_code)),
                        source_url: Some(chapter_url.clone()),
                        accessed_at: Some(context.build.accessed_at.to_string()),
                    },
                    content: None,
                })
                .await?;

            // Sort sections by code
            let mut sections = chapter.Sections.clone();
            sections.sort_by_key(|s| designator_sort_order(&s.Code));

            // Emit section nodes
            for (index, section_data) in sections.iter().enumerate() {
                let section_code = normalize_designator(&section_data.Code);
                let section_id = format!("{}/section-{}", chapter_id, section_code.to_lowercase());

                // Get section text if available - normalize first, then inline cross-references
                let mut raw_body = section_data.Text.clone().unwrap_or_default();

                // If body is empty, try to fetch from Details URL
                if raw_body.trim().is_empty() {
                    if let Some(details_url) = &section_data.Details {
                        // Ensure HTTPS
                        let secure_url = details_url.replace("http://", "https://");
                        let cache_key = format!(
                            "mgl-chapter-{}-section-{}.json",
                            parsed_chapter.chapter_code.to_lowercase(),
                            section_code.to_lowercase()
                        );

                        match context
                            .cache
                            .fetch_cached(&secure_url, Some(&cache_key))
                            .await
                        {
                            Ok(section_json) => {
                                match serde_json::from_str::<MglApiSection>(&section_json) {
                                    Ok(full_section) => {
                                        if let Some(text) = full_section.Text {
                                            raw_body = text;
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "Failed to parse section JSON for {}: {}",
                                            section_code, e
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!(
                                    "Failed to fetch section details for {}: {}",
                                    section_code, e
                                );
                            }
                        }
                    }
                }

                if raw_body.trim().is_empty() {
                    eprintln!(
                        "WARNING: Empty body for MGL section {} (Chapter {})",
                        section_code, parsed_chapter.chapter_code
                    );
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

                let heading_citation =
                    format!("MGL c.{} §{}", parsed_chapter.chapter_code, section_code);

                let section_name = section_data
                    .Name
                    .clone()
                    .unwrap_or_else(|| section_code.clone());

                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: section_id,
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(chapter_id.clone()),
                            level_name: "section".to_string(),
                            level_index: SECTION_LEVEL_INDEX,
                            sort_order: index as i32,
                            name: Some(section_name),
                            path: Some(format!(
                                "/statutes/mgl/part/{}/chapter/{}/section/{}",
                                payload.title_num.to_lowercase(),
                                parsed_chapter.chapter_code.to_lowercase(),
                                section_code.to_lowercase()
                            )),
                            readable_id: Some(section_code.clone()),
                            heading_citation: Some(heading_citation),
                            source_url: Some(format!(
                                "https://malegislature.gov/Laws/GeneralLaws/Part{}/Chapter{}/Section{}",
                                payload.title_num,parsed_chapter.chapter_code, section_code
                            )),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: Some(serde_json::to_value(&content).unwrap()),
                    })
                    .await?;
            }
        }

        Ok(())
    }

    fn unit_label(&self, unit: &UnitEntry) -> String {
        match serde_json::from_value::<MglUnitPayload>(unit.payload.clone()) {
            Ok(payload) => format!("Part {}", payload.title_num),
            Err(_) => unit.unit_id.clone(),
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
