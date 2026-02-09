use crate::runtime::cache::{ensure_cached_xml, read_cached_xml};
use crate::runtime::callbacks::{post_node_batch, post_unit_progress, post_unit_start};
use crate::runtime::types::{BuildContext, UnitStatus};
use crate::sources::adapter_for;
use crate::types::IngestConfig;
use reqwest::Client;

const BATCH_SIZE: usize = 200;

pub async fn ingest_source(config: IngestConfig) -> Result<(), String> {
    let client = Client::new();
    let adapter = adapter_for(config.source);

    tracing::info!(
        "[Container] Starting ingest for {} units",
        config.units.len()
    );

    for entry in &config.units {
        let unit_label = adapter.unit_label(entry);
        let result = ingest_unit(&client, &config, entry, adapter).await;

        match result {
            Ok(status) => {
                post_unit_progress(
                    &client,
                    &config.callback_base,
                    &config.callback_token,
                    &entry.unit_id,
                    status.as_str(),
                    None,
                )
                .await;
            }
            Err(err) => {
                tracing::error!("[Container] {} failed: {}", unit_label, err);
                post_unit_progress(
                    &client,
                    &config.callback_base,
                    &config.callback_token,
                    &entry.unit_id,
                    "error",
                    Some(&err),
                )
                .await;
            }
        }
    }

    tracing::info!("[Container] All units complete");
    Ok(())
}

async fn ingest_unit(
    client: &Client,
    config: &IngestConfig,
    entry: &crate::types::UnitEntry,
    adapter: &'static (dyn crate::sources::SourceAdapter + Send + Sync),
) -> Result<UnitStatus, String> {
    let accessed_at = chrono::Utc::now().to_rfc3339();
    let unit_label = adapter.unit_label(entry);

    tracing::info!("[Container] Starting ingest for {}", unit_label);

    let cache = match ensure_cached_xml(
        client,
        &entry.url,
        &config.callback_base,
        &config.callback_token,
    )
    .await?
    {
        Some(cache) => cache,
        None => {
            tracing::info!("[Container] {}: skipped (HTML response)", unit_label);
            return Ok(UnitStatus::Skipped);
        }
    };

    let xml = read_cached_xml(
        client,
        &cache,
        &config.callback_base,
        &config.callback_token,
    )
    .await?;

    let context = BuildContext {
        source_version_id: &config.source_version_id,
        root_node_id: &config.root_node_id,
        accessed_at: &accessed_at,
        unit_sort_order: entry.sort_order,
    };

    let mut prepared = adapter.build_nodes(entry, &context, &xml)?;
    let total_nodes = prepared.structure_nodes.len() + prepared.section_nodes.len();

    post_unit_start(
        client,
        &config.callback_base,
        &config.callback_token,
        &entry.unit_id,
        total_nodes,
    )
    .await?;

    for chunk in prepared.structure_nodes.chunks(BATCH_SIZE) {
        post_node_batch(
            client,
            &config.callback_base,
            &config.callback_token,
            &entry.unit_id,
            chunk,
        )
        .await?;
    }

    while !prepared.section_nodes.is_empty() {
        let remainder = if prepared.section_nodes.len() > BATCH_SIZE {
            prepared.section_nodes.split_off(BATCH_SIZE)
        } else {
            Vec::new()
        };

        post_node_batch(
            client,
            &config.callback_base,
            &config.callback_token,
            &entry.unit_id,
            &prepared.section_nodes,
        )
        .await?;

        prepared.section_nodes = remainder;
    }

    tracing::info!("[Container] {}: done", unit_label);
    Ok(UnitStatus::Completed)
}
