use crate::runtime::cache::{ensure_cached_xml, read_cached_xml};
use crate::runtime::callbacks::{post_node_batch, post_unit_progress, post_unit_start};
use crate::runtime::types::{BuildContext, IngestContext, NodeStore, BlobStore, UnitStatus};
use crate::sources::adapter_for;
use crate::types::{IngestConfig, NodePayload};
use reqwest::Client;
use std::sync::Mutex;
use async_trait::async_trait;

const BATCH_SIZE: usize = 200;

struct HttpNodeStore {
    client: Client,
    callback_base: String,
    callback_token: String,
    unit_id: String,
    buffer: Mutex<Vec<NodePayload>>,
}

#[async_trait]
impl NodeStore for HttpNodeStore {
    async fn insert_node(&self, node: NodePayload) -> Result<(), String> {
        let batch = {
            let mut buffer = self.buffer.lock().map_err(|e| e.to_string())?;
            buffer.push(node);
            if buffer.len() >= BATCH_SIZE {
                Some(std::mem::take(&mut *buffer))
            } else {
                None
            }
        };

        if let Some(batch) = batch {
            post_node_batch(
                &self.client,
                &self.callback_base,
                &self.callback_token,
                &self.unit_id,
                &batch,
            )
            .await?;
        }
        Ok(())
    }

    async fn flush(&self) -> Result<(), String> {
        let batch = {
            let mut buffer = self.buffer.lock().map_err(|e| e.to_string())?;
            if !buffer.is_empty() {
                Some(std::mem::take(&mut *buffer))
            } else {
                None
            }
        };

        if let Some(batch) = batch {
            post_node_batch(
                &self.client,
                &self.callback_base,
                &self.callback_token,
                &self.unit_id,
                &batch,
            )
            .await?;
        }
        Ok(())
    }
}

struct DummyBlobStore;

#[async_trait]
impl BlobStore for DummyBlobStore {
    async fn store_blob(&self, _id: &str, _content: &[u8]) -> Result<String, String> {
        // Placeholder implementation
        Ok("dummy-blob-id".to_string())
    }
}

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

    let build_context = BuildContext {
        source_version_id: &config.source_version_id,
        root_node_id: &config.root_node_id,
        accessed_at: &accessed_at,
        unit_sort_order: entry.sort_order,
    };

    let node_store = HttpNodeStore {
        client: client.clone(),
        callback_base: config.callback_base.clone(),
        callback_token: config.callback_token.clone(),
        unit_id: entry.unit_id.clone(),
        buffer: Mutex::new(Vec::with_capacity(BATCH_SIZE)),
    };

    let blob_store = DummyBlobStore;

    let mut context = IngestContext {
        build: build_context,
        nodes: Box::new(node_store),
        blobs: Box::new(blob_store),
    };

    // We don't know the total nodes anymore, so we pass 0 for now.
    // The backend might need to be updated if it strictly uses this.
    post_unit_start(
        client,
        &config.callback_base,
        &config.callback_token,
        &entry.unit_id,
        0,
    )
    .await?;

    adapter.process_unit(entry, &mut context, &xml).await?;

    context.nodes.flush().await?;

    tracing::info!("[Container] {}: done", unit_label);
    Ok(UnitStatus::Completed)
}
