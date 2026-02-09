use crate::runtime::types::{BuildContext, PreparedNodes};
use crate::sources::SourceAdapter;
use crate::types::{
    ContentBlock, NodeMeta, NodePayload, SectionContent, SectionMetadata, UnitEntry,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use crate::sources::usc::cross_references::extract_section_cross_references;
use crate::sources::usc::parser::{parse_usc_xml, section_level_index, USCParentRef};

pub struct UscAdapter;

pub const USC_ADAPTER: UscAdapter = UscAdapter;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UscUnitPayload {
    title_num: String,
}

impl SourceAdapter for UscAdapter {
    fn build_nodes(
        &self,
        unit: &UnitEntry,
        context: &BuildContext,
        xml: &str,
    ) -> Result<PreparedNodes, String> {
        let payload: UscUnitPayload = serde_json::from_value(unit.payload.clone())
            .map_err(|e| format!("Invalid USC unit payload for {}: {e}", unit.unit_id))?;
        let parsed = parse_usc_xml(xml, &payload.title_num, &unit.url);

        let mut structure_nodes: Vec<NodePayload> = Vec::new();
        let mut seen_level_ids: HashSet<String> = HashSet::new();
        let mut level_type_by_identifier: HashMap<String, String> = HashMap::new();
        let mut seen_section_keys: HashSet<String> = HashSet::new();
        let mut unique_sections = Vec::new();
        let mut level_sort_order: i32 = 0;
        let mut title_emitted = false;

        let ensure_title_node = |title_num: &str,
                                 title_name: &str,
                                 pending: &mut Vec<NodePayload>,
                                 seen: &mut HashSet<String>,
                                 emitted: &mut bool| {
            if *emitted {
                return;
            }
            *emitted = true;

            let title_string_id = format!("{}/title-{title_num}", context.root_node_id);
            seen.insert(format!("title-{title_num}"));

            pending.push(NodePayload {
                meta: NodeMeta {
                    id: title_string_id,
                    source_version_id: context.source_version_id.to_string(),
                    parent_id: Some(context.root_node_id.to_string()),
                    level_name: "title".to_string(),
                    level_index: 0,
                    sort_order: context.unit_sort_order,
                    name: Some(title_name.to_string()),
                    path: Some(format!("/statutes/usc/title/{title_num}")),
                    readable_id: Some(title_num.to_string()),
                    heading_citation: Some(format!("Title {title_num}")),
                    source_url: Some(unit.url.clone()),
                    accessed_at: Some(context.accessed_at.to_string()),
                },
                content: None,
            });
        };

        ensure_title_node(
            &parsed.title_num,
            &parsed.title_name,
            &mut structure_nodes,
            &mut seen_level_ids,
            &mut title_emitted,
        );

        for level in parsed.levels {
            if seen_level_ids.contains(&level.identifier) {
                continue;
            }

            ensure_title_node(
                &level.title_num,
                &format!("Title {}", level.title_num),
                &mut structure_nodes,
                &mut seen_level_ids,
                &mut title_emitted,
            );

            let parent_string_id = resolve_level_parent_string_id(
                context.root_node_id,
                level.parent_identifier.as_deref(),
                &level.title_num,
                &level_type_by_identifier,
            );
            let string_id = format!(
                "{}/{}-{}",
                context.root_node_id, level.level_type, level.identifier
            );
            let heading_citation = format!("{} {}", capitalize_first(&level.level_type), level.num);

            structure_nodes.push(NodePayload {
                meta: NodeMeta {
                    id: string_id,
                    source_version_id: context.source_version_id.to_string(),
                    parent_id: Some(parent_string_id),
                    level_name: level.level_type.clone(),
                    level_index: level.level_index as i32,
                    sort_order: level_sort_order,
                    name: Some(level.heading.clone()),
                    path: Some(format!(
                        "/statutes/usc/{}/{}/{}",
                        level.level_type, level.title_num, level.num
                    )),
                    readable_id: Some(level.num.clone()),
                    heading_citation: Some(heading_citation),
                    source_url: None,
                    accessed_at: Some(context.accessed_at.to_string()),
                },
                content: None,
            });

            level_sort_order += 1;
            level_type_by_identifier.insert(level.identifier.clone(), level.level_type.clone());
            seen_level_ids.insert(level.identifier.clone());
        }

        for section in parsed.sections {
            if seen_section_keys.insert(section.section_key.clone()) {
                unique_sections.push(section);
            }
        }

        ensure_title_node(
            &payload.title_num,
            &format!("Title {}", payload.title_num),
            &mut structure_nodes,
            &mut seen_level_ids,
            &mut title_emitted,
        );

        let section_level_idx = section_level_index() as i32;
        let mut section_nodes: Vec<NodePayload> = Vec::with_capacity(unique_sections.len());

        for section in unique_sections {
            let text_for_xrefs = [&section.body, &section.citations]
                .iter()
                .filter(|s| !s.is_empty())
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n");

            let cross_references =
                extract_section_cross_references(&text_for_xrefs, &section.title_num);

            let mut blocks = vec![ContentBlock {
                type_: "body".to_string(),
                content: section.body.clone(),
                label: None,
            }];
            if !section.history_short.is_empty() {
                blocks.push(ContentBlock {
                    type_: "history_short".to_string(),
                    content: section.history_short.clone(),
                    label: Some("Short History".to_string()),
                });
            }
            if !section.history_long.is_empty() {
                blocks.push(ContentBlock {
                    type_: "history_long".to_string(),
                    content: section.history_long.clone(),
                    label: Some("Long History".to_string()),
                });
            }
            if !section.citations.is_empty() {
                blocks.push(ContentBlock {
                    type_: "citations".to_string(),
                    content: section.citations.clone(),
                    label: Some("Notes".to_string()),
                });
            }

            let metadata = if cross_references.is_empty() {
                None
            } else {
                Some(SectionMetadata { cross_references })
            };
            let content = SectionContent { blocks, metadata };
            let readable_id = format!("{} USC {}", section.title_num, section.section_num);
            let parent_id = resolve_section_parent_string_id(context.root_node_id, &section.parent_ref);

            section_nodes.push(NodePayload {
                meta: NodeMeta {
                    id: format!("{}/section-{}", parent_id, section.section_num),
                    source_version_id: context.source_version_id.to_string(),
                    parent_id: Some(parent_id),
                    level_name: "section".to_string(),
                    level_index: section_level_idx,
                    sort_order: 0,
                    name: Some(section.heading.clone()),
                    path: Some(section.path.clone()),
                    readable_id: Some(readable_id.clone()),
                    heading_citation: Some(readable_id),
                    source_url: None,
                    accessed_at: Some(context.accessed_at.to_string()),
                },
                content: Some(serde_json::to_value(&content).unwrap()),
            });
        }

        Ok(PreparedNodes {
            structure_nodes,
            section_nodes,
        })
    }

    fn unit_label(&self, unit: &UnitEntry) -> String {
        match serde_json::from_value::<UscUnitPayload>(unit.payload.clone()) {
            Ok(payload) => format!("Title {}", payload.title_num),
            Err(_) => unit.unit_id.clone(),
        }
    }
}

fn resolve_level_parent_string_id(
    root_string_id: &str,
    level_parent_identifier: Option<&str>,
    level_title_num: &str,
    level_type_by_identifier: &HashMap<String, String>,
) -> String {
    if let Some(parent_id) = level_parent_identifier {
        if parent_id.ends_with("-title") {
            return format!("{root_string_id}/title-{level_title_num}");
        }
        if let Some(parent_type) = level_type_by_identifier.get(parent_id) {
            return format!("{root_string_id}/{parent_type}-{parent_id}");
        }
    }
    format!("{root_string_id}/title-{level_title_num}")
}

fn resolve_section_parent_string_id(root_string_id: &str, parent_ref: &USCParentRef) -> String {
    match parent_ref {
        USCParentRef::Title { title_num } => {
            format!("{root_string_id}/title-{title_num}")
        }
        USCParentRef::Level {
            level_type,
            identifier,
        } => {
            format!("{root_string_id}/{level_type}-{identifier}")
        }
    }
}

fn capitalize_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
