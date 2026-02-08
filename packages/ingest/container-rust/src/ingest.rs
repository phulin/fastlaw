use crate::cross_references::extract_section_cross_references;
use crate::parser::{
    parse_usc_section_content_xml, parse_usc_structure_events, section_level_index,
    USCParentRef, USCStructureEvent,
};
use crate::types::{
    ContentBlock, IngestConfig, NodePayload, NodeMeta, SectionContent, SectionMetadata,
    UscUnit,
};
use reqwest::Client;
use std::collections::{HashMap, HashSet};

const BATCH_SIZE: usize = 50;
const R2_CHUNK_SIZE: usize = 5 * 1024 * 1024;

// ──────────────────────────────────────────────────────────────
// Authenticated fetch helper
// ──────────────────────────────────────────────────────────────

async fn callback_fetch(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    path: &str,
    method: reqwest::Method,
    body: Option<serde_json::Value>,
) -> Result<reqwest::Response, String> {
    let url = format!("{callback_base}{path}");
    let mut builder = client.request(method, &url)
        .header("Authorization", format!("Bearer {callback_token}"));

    if let Some(json_body) = body {
        builder = builder
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&json_body).unwrap());
    }

    builder
        .send()
        .await
        .map_err(|e| format!("Request to {url} failed: {e}"))
}

// ──────────────────────────────────────────────────────────────
// Proxy-based streaming from worker R2 cache
// ──────────────────────────────────────────────────────────────

async fn fetch_cached_xml(
    client: &Client,
    url: &str,
    callback_base: &str,
    callback_token: &str,
) -> Result<Option<String>, String> {
    let cache_res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/proxy/cache",
        reqwest::Method::POST,
        Some(serde_json::json!({ "url": url, "extractZip": true })),
    )
    .await?;

    let status = cache_res.status();

    if status.as_u16() == 422 {
        let body: serde_json::Value = cache_res
            .json()
            .await
            .map_err(|e| format!("Failed to parse 422 response: {e}"))?;
        if body.get("error").and_then(|v| v.as_str()) == Some("html_response") {
            return Ok(None);
        }
        return Err(format!("Cache proxy failed: 422"));
    }

    if !status.is_success() {
        let text = cache_res.text().await.unwrap_or_default();
        return Err(format!("Cache proxy failed: {status} {text}"));
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CacheResponse {
        r2_key: String,
        total_size: usize,
    }

    let cache_info: CacheResponse = cache_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse cache response: {e}"))?;

    // Read all chunks into a single string
    let mut xml_bytes = Vec::with_capacity(cache_info.total_size);
    let mut offset = 0;
    while offset < cache_info.total_size {
        let length = std::cmp::min(R2_CHUNK_SIZE, cache_info.total_size - offset);
        let params = format!(
            "key={}&offset={}&length={}",
            urlencoding::encode(&cache_info.r2_key),
            offset,
            length
        );
        let chunk_res = callback_fetch(
            client,
            callback_base,
            callback_token,
            &format!("/api/proxy/r2-read?{params}"),
            reqwest::Method::GET,
            None,
        )
        .await?;

        if !chunk_res.status().is_success() {
            return Err(format!("R2 read failed: {}", chunk_res.status()));
        }

        let bytes = chunk_res
            .bytes()
            .await
            .map_err(|e| format!("Failed to read chunk bytes: {e}"))?;
        xml_bytes.extend_from_slice(&bytes);
        offset += length;
    }

    String::from_utf8(xml_bytes)
        .map(Some)
        .map_err(|e| format!("Invalid UTF-8 in XML: {e}"))
}

// ──────────────────────────────────────────────────────────────
// Callback helpers
// ──────────────────────────────────────────────────────────────

async fn post_node_batch(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    unit_id: &str,
    nodes: &[NodePayload],
) -> Result<(), String> {
    let res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/insertNodeBatch",
        reqwest::Method::POST,
        Some(serde_json::json!({ "unitId": unit_id, "nodes": nodes })),
    )
    .await?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Insert callback failed: {text}"));
    }
    Ok(())
}

async fn post_unit_start(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    unit_id: &str,
    total_nodes: usize,
) -> Result<(), String> {
    let res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/unitStart",
        reqwest::Method::POST,
        Some(serde_json::json!({ "unitId": unit_id, "totalNodes": total_nodes })),
    )
    .await?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Unit start callback failed: {text}"));
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Parent resolution
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// Per-unit ingest
// ──────────────────────────────────────────────────────────────

enum UnitStatus {
    Completed,
    Skipped,
}

impl UnitStatus {
    fn as_str(&self) -> &str {
        match self {
            UnitStatus::Completed => "completed",
            UnitStatus::Skipped => "skipped",
        }
    }
}

async fn ingest_usc_unit(
    client: &Client,
    unit: &UscUnit,
    title_sort_order: i32,
    callback_base: &str,
    callback_token: &str,
    source_version_id: &str,
    root_node_id: &str,
) -> Result<UnitStatus, String> {
    let accessed_at = chrono::Utc::now().to_rfc3339();
    let root_string_id = root_node_id;

    tracing::info!("[Container] Starting ingest for Title {}", unit.title_num);

    // ── Phase 1: Parse structure ─────────────────────────────
    let xml = match fetch_cached_xml(client, &unit.url, callback_base, callback_token).await? {
        Some(xml) => xml,
        None => {
            tracing::info!(
                "[Container] Title {}: skipped (HTML response)",
                unit.title_num
            );
            return Ok(UnitStatus::Skipped);
        }
    };

    let structure_events = parse_usc_structure_events(&xml, &unit.title_num, &unit.url);

    let mut pending_nodes: Vec<NodePayload> = Vec::new();
    let mut seen_level_ids: HashSet<String> = HashSet::new();
    let mut level_type_by_identifier: HashMap<String, String> = HashMap::new();
    let mut section_refs: Vec<SectionRefEntry> = Vec::new();
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

        let title_string_id = format!("{root_string_id}/title-{title_num}");
        seen.insert(format!("title-{title_num}"));

        pending.push(NodePayload {
            meta: NodeMeta {
                id: title_string_id,
                source_version_id: source_version_id.to_string(),
                parent_id: Some(root_string_id.to_string()),
                level_name: "title".to_string(),
                level_index: 0,
                sort_order: title_sort_order,
                name: Some(title_name.to_string()),
                path: Some(format!("/statutes/usc/title/{title_num}")),
                readable_id: Some(title_num.to_string()),
                heading_citation: Some(format!("Title {title_num}")),
                source_url: Some(unit.url.clone()),
                accessed_at: Some(accessed_at.clone()),
            },
            content: None,
        });
    };

    for event in &structure_events {
        match event {
            USCStructureEvent::Title {
                title_num,
                title_name,
            } => {
                ensure_title_node(
                    title_num,
                    title_name,
                    &mut pending_nodes,
                    &mut seen_level_ids,
                    &mut title_emitted,
                );
            }
            USCStructureEvent::Level(level) => {
                if seen_level_ids.contains(&level.identifier) {
                    continue;
                }
                ensure_title_node(
                    &level.title_num,
                    &format!("Title {}", level.title_num),
                    &mut pending_nodes,
                    &mut seen_level_ids,
                    &mut title_emitted,
                );

                let parent_string_id = resolve_level_parent_string_id(
                    root_string_id,
                    level.parent_identifier.as_deref(),
                    &level.title_num,
                    &level_type_by_identifier,
                );
                let string_id =
                    format!("{root_string_id}/{}-{}", level.level_type, level.identifier);
                let heading_citation = format!(
                    "{} {}",
                    capitalize_first(&level.level_type),
                    level.num
                );

                pending_nodes.push(NodePayload {
                    meta: NodeMeta {
                        id: string_id,
                        source_version_id: source_version_id.to_string(),
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
                        accessed_at: Some(accessed_at.clone()),
                    },
                    content: None,
                });

                level_sort_order += 1;
                level_type_by_identifier
                    .insert(level.identifier.clone(), level.level_type.clone());
                seen_level_ids.insert(level.identifier.clone());
            }
            USCStructureEvent::Section(section) => {
                let parent_string_id =
                    resolve_section_parent_string_id(root_string_id, &section.parent_ref);
                let child_id = format!("{parent_string_id}/section-{}", section.section_num);

                section_refs.push(SectionRefEntry {
                    section_key: section.section_key.clone(),
                    parent_id: parent_string_id,
                    child_id,
                });
            }
        }
    }

    ensure_title_node(
        &unit.title_num,
        &format!("Title {}", unit.title_num),
        &mut pending_nodes,
        &mut seen_level_ids,
        &mut title_emitted,
    );

    let total_nodes = pending_nodes.len() + section_refs.len();
    post_unit_start(client, callback_base, callback_token, &unit.id, total_nodes).await?;

    // Flush structure nodes in batches
    for chunk in pending_nodes.chunks(BATCH_SIZE) {
        post_node_batch(client, callback_base, callback_token, &unit.id, chunk).await?;
    }

    tracing::info!(
        "[Container] Title {}: {} structure nodes, {} sections",
        unit.title_num,
        pending_nodes.len(),
        section_refs.len()
    );

    // ── Phase 2: Parse section content ───────────────────────
    if !section_refs.is_empty() {
        let sections = parse_usc_section_content_xml(&xml, &unit.title_num, &unit.url);

        let mut section_by_key: HashMap<String, &SectionRefEntry> =
            section_refs.iter().map(|s| (s.section_key.clone(), s)).collect();
        let mut section_batch: Vec<NodePayload> = Vec::new();
        let section_level_idx = section_level_index() as i32;

        for section in &sections {
            let item = match section_by_key.get(&section.section_key) {
                Some(item) => *item,
                None => continue,
            };

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

            section_batch.push(NodePayload {
                meta: NodeMeta {
                    id: item.child_id.clone(),
                    source_version_id: source_version_id.to_string(),
                    parent_id: Some(item.parent_id.clone()),
                    level_name: "section".to_string(),
                    level_index: section_level_idx,
                    sort_order: 0,
                    name: Some(section.heading.clone()),
                    path: Some(section.path.clone()),
                    readable_id: Some(readable_id.clone()),
                    heading_citation: Some(readable_id),
                    source_url: None,
                    accessed_at: Some(accessed_at.clone()),
                },
                content: Some(serde_json::to_value(&content).unwrap()),
            });

            if section_batch.len() >= BATCH_SIZE {
                post_node_batch(
                    client,
                    callback_base,
                    callback_token,
                    &unit.id,
                    &section_batch,
                )
                .await?;
                section_batch.clear();
            }

            section_by_key.remove(&section.section_key);
        }

        if !section_batch.is_empty() {
            post_node_batch(
                client,
                callback_base,
                callback_token,
                &unit.id,
                &section_batch,
            )
            .await?;
        }

        if !section_by_key.is_empty() {
            let missing: Vec<_> = section_by_key.keys().take(5).collect();
            tracing::warn!(
                "[Container] Title {}: {} sections not found in content pass: {}",
                unit.title_num,
                section_by_key.len(),
                missing
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }

    tracing::info!("[Container] Title {}: done", unit.title_num);
    Ok(UnitStatus::Completed)
}

#[derive(Debug)]
struct SectionRefEntry {
    section_key: String,
    parent_id: String,
    child_id: String,
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// ──────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────

pub async fn ingest_usc(config: IngestConfig) -> Result<(), String> {
    let client = Client::new();

    tracing::info!(
        "[Container] Starting ingest for {} units",
        config.units.len()
    );

    for entry in &config.units {
        let result = ingest_usc_unit(
            &client,
            &entry.unit,
            entry.title_sort_order,
            &config.callback_base,
            &config.callback_token,
            &config.source_version_id,
            &config.root_node_id,
        )
        .await;

        match result {
            Ok(status) => {
                let _ = callback_fetch(
                    &client,
                    &config.callback_base,
                    &config.callback_token,
                    "/api/callback/progress",
                    reqwest::Method::POST,
                    Some(serde_json::json!({
                        "unitId": entry.unit.id,
                        "status": status.as_str()
                    })),
                )
                .await;
            }
            Err(err) => {
                tracing::error!(
                    "[Container] Title {} failed: {}",
                    entry.unit.title_num,
                    err
                );
                let _ = callback_fetch(
                    &client,
                    &config.callback_base,
                    &config.callback_token,
                    "/api/callback/progress",
                    reqwest::Method::POST,
                    Some(serde_json::json!({
                        "unitId": entry.unit.id,
                        "status": "error",
                        "error": err
                    })),
                )
                .await;
            }
        }
    }

    tracing::info!("[Container] All units complete");
    Ok(())
}
