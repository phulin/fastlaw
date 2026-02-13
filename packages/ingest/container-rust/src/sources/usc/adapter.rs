use crate::runtime::types::IngestContext;
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, NodeMeta, NodePayload, SectionContent, UnitEntry};
use async_trait::async_trait;
use serde::Deserialize;
use std::collections::HashSet;
use tokio::sync::mpsc;

use crate::sources::usc::parser::{
    parse_usc_xml_stream, section_level_index, USCParentRef, USCStreamEvent,
};

pub struct UscAdapter;

pub const USC_ADAPTER: UscAdapter = UscAdapter;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UscUnitPayload {
    title_num: String,
}

#[async_trait]
impl SourceAdapter for UscAdapter {
    async fn discover(
        &self,
        fetcher: &dyn crate::runtime::fetcher::Fetcher,
        download_base: &str,
    ) -> Result<crate::types::DiscoveryResult, String> {
        crate::sources::usc::discover::discover_usc_root(fetcher, download_base).await
    }

    async fn process_unit(
        &self,
        unit: &UnitEntry,
        context: &mut IngestContext<'_>,
        xml: &str,
    ) -> Result<(), String> {
        let payload: UscUnitPayload = serde_json::from_value(unit.payload.clone())
            .map_err(|e| format!("Invalid USC unit payload for {}: {e}", unit.unit_id))?;

        let mut seen_level_ids: HashSet<String> = HashSet::new();
        let mut seen_section_keys: HashSet<String> = HashSet::new();
        let mut level_sort_order: i32 = 0;
        let mut title_emitted = false;

        let (tx, mut rx) = mpsc::channel(100);

        let xml_str = xml.to_string();
        let title_num_payload = payload.title_num.clone();

        std::thread::spawn(move || {
            parse_usc_xml_stream(&xml_str, &title_num_payload, |event| {
                if let Err(e) = tx.blocking_send(event) {
                    tracing::error!("Failed to send USC event: {e}");
                }
            });
        });

        let section_level_idx = section_level_index() as i32;
        let mut title_name_from_parser: Option<String> = None;

        while let Some(event) = rx.recv().await {
            match event {
                USCStreamEvent::Title(name) => {
                    title_name_from_parser = Some(name);
                }
                USCStreamEvent::Level(level) => {
                    if !title_emitted {
                        let title_name = title_name_from_parser
                            .clone()
                            .unwrap_or_else(|| format!("Title {}", level.title_num));
                        emit_title_node(
                            unit,
                            context,
                            &level.title_num,
                            &title_name,
                            &mut seen_level_ids,
                        )
                        .await?;
                        title_emitted = true;
                    }

                    if seen_level_ids.contains(&level.identifier) {
                        continue;
                    }

                    let parent_string_id = resolve_level_parent_string_id(
                        context.build.root_node_id,
                        level.parent_identifier.as_deref(),
                        &level.title_num,
                    );
                    let string_id = format!("{}/{}", context.build.root_node_id, level.identifier);
                    let heading_citation =
                        format!("{} {}", capitalize_first(&level.level_type), level.num);

                    context
                        .nodes
                        .insert_node(NodePayload {
                            meta: NodeMeta {
                                id: string_id,
                                source_version_id: context.build.source_version_id.to_string(),
                                parent_id: Some(parent_string_id),
                                level_name: level.level_type.to_string(),
                                level_index: level.level_index as i32,
                                sort_order: level_sort_order,
                                name: Some(level.heading.clone()),
                                path: Some(level.path.clone()),
                                readable_id: Some(level.num.clone()),
                                heading_citation: Some(heading_citation),
                                source_url: None,
                                accessed_at: Some(context.build.accessed_at.to_string()),
                            },
                            content: None,
                        })
                        .await?;

                    level_sort_order += 1;
                    seen_level_ids.insert(level.identifier.clone());
                }
                USCStreamEvent::Section(section) => {
                    if !title_emitted {
                        let title_name = title_name_from_parser
                            .clone()
                            .unwrap_or_else(|| format!("Title {}", section.title_num));
                        emit_title_node(
                            unit,
                            context,
                            &section.title_num,
                            &title_name,
                            &mut seen_level_ids,
                        )
                        .await?;
                        title_emitted = true;
                    }

                    if !seen_section_keys.insert(section.section_key.clone()) {
                        continue;
                    }

                    let body_content = section.body.clone();

                    let mut blocks = vec![ContentBlock {
                        type_: "body".to_string(),
                        content: if body_content.trim().is_empty() {
                            None
                        } else {
                            Some(body_content)
                        },
                        label: None,
                    }];
                    for block in &section.blocks {
                        let block_content = block.content.clone();
                        blocks.push(ContentBlock {
                            type_: block.type_.clone(),
                            content: block_content.and_then(|content| {
                                if content.trim().is_empty() {
                                    None
                                } else {
                                    Some(content)
                                }
                            }),
                            label: block.label.clone(),
                        });
                    }

                    let content = SectionContent {
                        blocks,
                        metadata: None,
                    };
                    let readable_id = format!("{} USC {}", section.title_num, section.section_num);
                    let parent_id = resolve_section_parent_string_id(
                        context.build.root_node_id,
                        &section.parent_ref,
                    );

                    context
                        .nodes
                        .insert_node(NodePayload {
                            meta: NodeMeta {
                                id: format!("{}/section-{}", parent_id, section.section_num),
                                source_version_id: context.build.source_version_id.to_string(),
                                parent_id: Some(parent_id),
                                level_name: "section".to_string(),
                                level_index: section_level_idx,
                                sort_order: 0,
                                name: Some(section.heading.clone()),
                                path: Some(section.path.clone()),
                                readable_id: Some(readable_id.clone()),
                                heading_citation: Some(readable_id),
                                source_url: None,
                                accessed_at: Some(context.build.accessed_at.to_string()),
                            },
                            content: Some(serde_json::to_value(&content).unwrap()),
                        })
                        .await?;
                }
            }
        }

        Ok(())
    }

    fn unit_label(&self, unit: &UnitEntry) -> String {
        match serde_json::from_value::<UscUnitPayload>(unit.payload.clone()) {
            Ok(payload) => format!("Title {}", payload.title_num),
            Err(_) => unit.unit_id.clone(),
        }
    }
}

async fn emit_title_node(
    unit: &UnitEntry,
    context: &mut IngestContext<'_>,
    title_num: &str,
    title_name: &str,
    seen_level_ids: &mut HashSet<String>,
) -> Result<(), String> {
    let native_id = format!("t{title_num}/root");
    if seen_level_ids.contains(&native_id) {
        return Ok(());
    }
    seen_level_ids.insert(native_id.clone());

    let title_string_id = format!("{}/{native_id}", context.build.root_node_id);

    context
        .nodes
        .insert_node(NodePayload {
            meta: NodeMeta {
                id: title_string_id,
                source_version_id: context.build.source_version_id.to_string(),
                parent_id: Some(context.build.root_node_id.to_string()),
                level_name: "title".to_string(),
                level_index: 0,
                sort_order: context.build.unit_sort_order,
                name: Some(title_name.to_string()),
                path: Some(format!("/statutes/usc/title/{title_num}")),
                readable_id: Some(title_num.to_string()),
                heading_citation: Some(format!("Title {title_num}")),
                source_url: Some(unit.url.clone()),
                accessed_at: Some(context.build.accessed_at.to_string()),
            },
            content: None,
        })
        .await
}

fn resolve_level_parent_string_id(
    root_string_id: &str,
    level_parent_identifier: Option<&str>,
    level_title_num: &str,
) -> String {
    if let Some(parent_id) = level_parent_identifier {
        return format!("{root_string_id}/{parent_id}");
    }
    format!("{root_string_id}/t{level_title_num}/root")
}

fn resolve_section_parent_string_id(root_string_id: &str, parent_ref: &USCParentRef) -> String {
    match parent_ref {
        USCParentRef::Title { title_num } => {
            format!("{root_string_id}/t{title_num}/root")
        }
        USCParentRef::Level { identifier, .. } => {
            format!("{root_string_id}/{identifier}")
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
