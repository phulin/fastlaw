use crate::runtime::types::IngestContext;
use crate::sources::cga::cross_references::inline_section_cross_references;
use crate::sources::cga::parser::{
    designator_sort_order, normalize_designator, parse_cga_chapter_html, CgaUnitKind,
};
use crate::sources::SourceAdapter;
use crate::types::{ContentBlock, NodeMeta, NodePayload, SectionContent, UnitEntry};
use async_trait::async_trait;
use serde::Deserialize;

pub struct CgaAdapter;

pub const CGA_ADAPTER: CgaAdapter = CgaAdapter;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CgaUnitPayload {
    title_id: String,
    title_name: Option<String>,
    chapter_id: String,
    chapter_name: Option<String>,
    unit_kind: Option<String>,
    title_sort_order: Option<i32>,
    chapter_sort_order: Option<i32>,
}

#[async_trait]
impl SourceAdapter for CgaAdapter {
    async fn discover(
        &self,
        client: &reqwest::Client,
        _download_base: &str,
    ) -> Result<crate::types::DiscoveryResult, String> {
        crate::sources::cga::discover::discover_cga_root(
            client,
            crate::sources::cga::discover::cga_titles_page_url(),
        )
        .await
    }

    async fn process_unit(
        &self,
        unit: &UnitEntry,
        context: &mut IngestContext<'_>,
        html: &str,
    ) -> Result<(), String> {
        let payload: CgaUnitPayload = serde_json::from_value(unit.payload.clone())
            .map_err(|err| format!("Invalid CGA unit payload for {}: {err}", unit.unit_id))?;

        let normalized_title_id = normalize_designator(Some(&payload.title_id))
            .unwrap_or_else(|| payload.title_id.clone());
        let unit_kind = match payload.unit_kind.as_deref() {
            Some("article") => CgaUnitKind::Article,
            Some("chapter") => CgaUnitKind::Chapter,
            _ => CgaUnitKind::from_url(&unit.url),
        };

        let parsed = parse_cga_chapter_html(html, &payload.chapter_id, &unit.url, unit_kind);

        let title_id = format!("{}/title-{normalized_title_id}", context.build.root_node_id);
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
                    source_url: Some(unit.url.clone()),
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
                    source_url: Some(unit.url.clone()),
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

        Ok(())
    }

    fn unit_label(&self, unit: &UnitEntry) -> String {
        match serde_json::from_value::<CgaUnitPayload>(unit.payload.clone()) {
            Ok(payload) => format!(
                "{} {}",
                payload.unit_kind.unwrap_or_else(|| "chapter".to_string()),
                payload.chapter_id
            ),
            Err(_) => unit.unit_id.clone(),
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
