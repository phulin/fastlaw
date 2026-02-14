use crate::info;
use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::sources::common::{body_block, capitalize_first};
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, DiscoveryResult, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use std::collections::HashSet;
use tokio::sync::mpsc;

use crate::sources::usc::parser::{
    parse_usc_xml_stream, section_level_index, USCParentRef, USCStreamEvent,
};

pub struct UscAdapter;

pub const USC_ADAPTER: UscAdapter = UscAdapter;

#[async_trait]
impl SourceAdapter for UscAdapter {
    async fn discover(&self, fetcher: &dyn Fetcher, url: &str) -> Result<DiscoveryResult, String> {
        crate::sources::usc::discover::discover_usc_root(fetcher, url).await
    }

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String> {
        let url = &item.url;
        let metadata = &item.metadata;

        match item.level_name.as_str() {
            "title" => {
                let title_num = metadata["title_num"].as_str().unwrap_or_default();
                let version_id = &context.build.source_version_id;
                let cache_key = format!("usc/{}/title-{}.xml", version_id, title_num);
                let xml = context.cache.fetch_cached(url, &cache_key).await?;

                let mut seen_level_ids: HashSet<String> = HashSet::new();
                let mut seen_section_keys: HashSet<String> = HashSet::new();
                let mut level_sort_order: i32 = 0;

                let (tx, mut rx) = mpsc::channel(100);
                let xml_str = xml.to_string();
                let title_num_payload = title_num.to_string();

                info!(
                    context,
                    "Processing USC Title {} (XML size: {} bytes, first 100 chars: {:?})",
                    title_num,
                    xml_str.len(),
                    xml_str.chars().take(100).collect::<String>()
                );

                std::thread::spawn(move || {
                    parse_usc_xml_stream(&xml_str, &title_num_payload, |event| {
                        if let Err(e) = tx.blocking_send(event) {
                            tracing::error!("Failed to send USC event: {e}");
                        }
                    });
                });

                let section_level_idx = section_level_index() as i32;
                let mut title_name = format!("Title {}", title_num);
                let mut title_emitted = false;
                let mut event_count = 0;

                while let Some(event) = rx.recv().await {
                    event_count += 1;
                    if event_count % 1000 == 0 {
                        info!(
                            context,
                            "Processing USC Title {}... ({} events)", title_num, event_count
                        );
                        // Yield to let the executor handle background tasks (like log callbacks)
                        tokio::task::yield_now().await;
                    }

                    match event {
                        USCStreamEvent::Title(name) => {
                            title_name = name;
                            if !title_emitted {
                                emit_title_node(
                                    url,
                                    context,
                                    title_num,
                                    &title_name,
                                    &mut seen_level_ids,
                                )
                                .await?;
                                title_emitted = true;
                            }
                        }
                        USCStreamEvent::Level(level) => {
                            if !title_emitted {
                                emit_title_node(
                                    url,
                                    context,
                                    title_num,
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
                            let string_id =
                                format!("{}/{}", context.build.root_node_id, level.identifier);
                            let heading_citation =
                                format!("{} {}", capitalize_first(&level.level_type), level.num);

                            context
                                .nodes
                                .insert_node(NodePayload {
                                    meta: NodeMeta {
                                        id: string_id,
                                        source_version_id: context
                                            .build
                                            .source_version_id
                                            .to_string(),
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
                                emit_title_node(
                                    url,
                                    context,
                                    title_num,
                                    &title_name,
                                    &mut seen_level_ids,
                                )
                                .await?;
                                title_emitted = true;
                            }

                            if !seen_section_keys.insert(section.section_key.clone()) {
                                continue;
                            }

                            let mut blocks = vec![body_block(&section.body)];
                            for block in &section.blocks {
                                blocks.push(ContentBlock {
                                    type_: block.type_.clone(),
                                    content: block.content.clone().and_then(|c| {
                                        if c.trim().is_empty() {
                                            None
                                        } else {
                                            Some(c)
                                        }
                                    }),
                                    label: block.label.clone(),
                                });
                            }

                            let content = SectionContent {
                                blocks,
                                metadata: None,
                            };
                            let readable_id =
                                format!("{} USC {}", section.title_num, section.section_num);
                            let parent_id = resolve_section_parent_string_id(
                                context.build.root_node_id,
                                &section.parent_ref,
                            );

                            context
                                .nodes
                                .insert_node(NodePayload {
                                    meta: NodeMeta {
                                        id: format!(
                                            "{}/section-{}",
                                            parent_id, section.section_num
                                        ),
                                        source_version_id: context
                                            .build
                                            .source_version_id
                                            .to_string(),
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
                        USCStreamEvent::Error(e) => {
                            return Err(format!("Error parsing USC XML: {}", e));
                        }
                    }
                }

                info!(
                    context,
                    "Finished processing USC Title {}. Total events: {}", title_num, event_count
                );
            }
            other => return Err(format!("Unknown USC level: {other}")),
        }

        Ok(())
    }

    fn unit_label(&self, item: &QueueItem) -> String {
        format!(
            "Title {}",
            item.metadata["title_num"].as_str().unwrap_or("?")
        )
    }
}

async fn emit_title_node(
    url: &str,
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
                source_url: Some(url.to_string()),
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
