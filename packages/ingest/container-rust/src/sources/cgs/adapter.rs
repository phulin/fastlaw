use crate::runtime::types::IngestContext;
use crate::sources::cgs::cross_references::inline_section_cross_references;
use crate::sources::cgs::parser::{
    designator_sort_order, normalize_designator, parse_cgs_chapter_html, CgsUnitKind,
};
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, NodeMeta, NodePayload, SectionContent};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

pub struct CgsAdapter;

pub const CGS_ADAPTER: CgsAdapter = CgsAdapter;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CgsUnitPayload {
    title_id: String,
    title_name: Option<String>,
    chapter_id: String,
    chapter_name: Option<String>,
    unit_kind: Option<String>,
    title_sort_order: Option<i32>,
    chapter_sort_order: Option<i32>,
}

#[async_trait]
impl SourceAdapter for CgsAdapter {
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
                    crate::sources::cgs::discover::discover_cgs_root(&fetcher, url).await?;

                for (i, root) in discovery.unit_roots.into_iter().enumerate() {
                    context.queue.enqueue(
                        root.url,
                        json!({
                            "type": "unit",
                            "unit_id": root.id,
                            "title_num": root.title_num, // title_id actually
                            "payload": root.payload,
                            "sort_order": i as i32
                        }),
                    );
                }

                context.queue.enqueue(
                    "discovery-result".to_string(),
                    json!({
                        "type": "discovery_result",
                        "version_id": discovery.version_id,
                        "root_node": discovery.root_node,
                    }),
                );
            }
            "unit" => {
                let payload: CgsUnitPayload =
                    serde_json::from_value(metadata["payload"].clone())
                        .map_err(|err| format!("Invalid CGS unit payload: {err}"))?;

                let cache_key = format!("cgs/{}.html", payload.chapter_id);
                let html = context.cache.fetch_cached(url, &cache_key).await?;

                let normalized_title_id = normalize_designator(Some(&payload.title_id))
                    .unwrap_or_else(|| payload.title_id.clone());
                let unit_kind = match payload.unit_kind.as_deref() {
                    Some("article") => CgsUnitKind::Article,
                    Some("chapter") => CgsUnitKind::Chapter,
                    _ => CgsUnitKind::from_url(url),
                };

                let parsed = parse_cgs_chapter_html(&html, &payload.chapter_id, url, unit_kind);

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
                            sort_order: payload
                                .title_sort_order
                                .unwrap_or_else(|| designator_sort_order(&normalized_title_id)),
                            name: payload
                                .title_name
                                .clone()
                                .or_else(|| Some(format!("Title {normalized_title_id}"))),
                            path: Some(format!("/statutes/cgs/title/{normalized_title_id}")),
                            readable_id: Some(normalized_title_id.clone()),
                            heading_citation: Some(format!("Title {normalized_title_id}")),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                let chapter_string_id = format!(
                    "{}/{kind}-{id}",
                    title_id,
                    kind = unit_kind.as_str(),
                    id = payload.chapter_id
                );
                context
                    .nodes
                    .insert_node(NodePayload {
                        meta: NodeMeta {
                            id: chapter_string_id.clone(),
                            source_version_id: context.build.source_version_id.to_string(),
                            parent_id: Some(title_id.clone()),
                            level_name: unit_kind.as_str().to_string(),
                            level_index: 1,
                            sort_order: payload
                                .chapter_sort_order
                                .unwrap_or_else(|| designator_sort_order(&payload.chapter_id)),
                            name: payload
                                .chapter_name
                                .clone()
                                .or(parsed.chapter_title.clone()),
                            path: Some(format!(
                                "/statutes/cgs/{}/{}/{}",
                                unit_kind.as_str(),
                                normalized_title_id,
                                payload.chapter_id
                            )),
                            readable_id: Some(payload.chapter_id.clone()),
                            heading_citation: Some(format!(
                                "{} {}",
                                capitalize_first(unit_kind.as_str()),
                                payload.chapter_id
                            )),
                            source_url: Some(url.to_string()),
                            accessed_at: Some(context.build.accessed_at.to_string()),
                        },
                        content: None,
                    })
                    .await?;

                for section in parsed.sections {
                    let body = inline_section_cross_references(&section.body);
                    let mut blocks = vec![ContentBlock {
                        type_: "body".to_string(),
                        label: None,
                        content: if body.trim().is_empty() {
                            None
                        } else {
                            Some(body)
                        },
                    }];

                    push_block(
                        &mut blocks,
                        "history_short",
                        "Short History",
                        section.history_short,
                        false,
                    );
                    push_block(
                        &mut blocks,
                        "history_long",
                        "Long History",
                        section.history_long,
                        false,
                    );
                    push_block(
                        &mut blocks,
                        "citations",
                        "Citations",
                        section.citations,
                        false,
                    );
                    push_block(&mut blocks, "see_also", "See Also", section.see_also, true);

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
            _ => return Err(format!("Unknown CGS task type: {task_type}")),
        }

        Ok(())
    }

    fn unit_label(&self, metadata: &serde_json::Value) -> String {
        let payload: Result<CgsUnitPayload, _> =
            serde_json::from_value(metadata["payload"].clone());
        match payload {
            Ok(p) => format!(
                "{} {}",
                p.unit_kind.unwrap_or_else(|| "chapter".to_string()),
                p.chapter_id
            ),
            Err(_) => "CGS Task".to_string(),
        }
    }
}

fn push_block(
    blocks: &mut Vec<ContentBlock>,
    type_: &str,
    label: &str,
    value: Option<String>,
    inline_refs: bool,
) {
    if let Some(content) = value {
        let rendered = if inline_refs {
            inline_section_cross_references(&content)
        } else {
            content
        };
        if !rendered.trim().is_empty() {
            blocks.push(ContentBlock {
                type_: type_.to_string(),
                label: Some(label.to_string()),
                content: Some(rendered),
            });
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
