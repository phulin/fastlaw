use crate::runtime::cache::{ensure_cached, read_cached_file};
use crate::runtime::callbacks::{
    post_ensure_source_version, post_node_batch, post_unit_progress, post_unit_start,
};
use crate::runtime::types::{BlobStore, BuildContext, Cache, IngestContext, NodeStore, UnitStatus};
use crate::sources::adapter_for;
use crate::types::{IngestConfig, NodePayload, UnitEntry};
use async_trait::async_trait;
use reqwest::Client;
use std::sync::Mutex;
use std::time::Duration;

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

struct HttpCache {
    client: Client,
    callback_base: String,
    callback_token: String,
}

#[async_trait]
impl Cache for HttpCache {
    async fn fetch_cached(&self, url: &str, key: Option<&str>) -> Result<String, String> {
        let cache_result = ensure_cached(
            &self.client,
            url,
            &self.callback_base,
            &self.callback_token,
            false,
            key,
        )
        .await?;

        let cache_info = cache_result.ok_or_else(|| {
            format!(
                "Cache proxy returned 422 for URL (likely HTML response): {}",
                url
            )
        })?;

        read_cached_file(
            &self.client,
            &cache_info,
            &self.callback_base,
            &self.callback_token,
        )
        .await
    }
}

pub async fn ingest_source(config: IngestConfig) -> Result<(), String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|err| format!("Failed to build HTTP client: {err}"))?;
    let adapter = adapter_for(config.source);

    // Determines the units to process and the version context
    let (units, source_version_id, root_node_id) = if let Some(units) = &config.units {
        // Pre-configured mode (legacy or direct unit targeting)
        let svid = config
            .source_version_id
            .clone()
            .ok_or("Missing source_version_id in config with units")?;
        let rnid = config
            .root_node_id
            .clone()
            .ok_or("Missing root_node_id in config with units")?;
        (units.clone(), svid, rnid)
    } else {
        // Discovery mode
        tracing::info!("[Container] Exploring source...");
        let discovery = match adapter
            .discover(&client, "https://uscode.house.gov/download/download.shtml")
            .await
        {
            Ok(discovery) => discovery,
            Err(err) => return Err(err),
        };

        let source_version_id = format!("{}-{}", config.source_id, discovery.version_id);
        let root_node_id = discovery.root_node.id.clone();

        tracing::info!(
            "[Container] Discovered version: {}, root: {}",
            source_version_id,
            root_node_id
        );

        // Filter units based on selectors
        let filtered_roots: Vec<crate::types::UscUnitRoot> =
            if let Some(selectors) = &config.selectors {
                if selectors.is_empty() {
                    discovery.unit_roots
                } else {
                    discovery
                        .unit_roots
                        .into_iter()
                        .filter(|u| selectors.contains(&u.title_num))
                        .collect()
                }
            } else {
                discovery.unit_roots
            };
        // Ensure source version exists in backend
        post_ensure_source_version(
            &client,
            &config.callback_base,
            &config.callback_token,
            &config.source_id,
            &source_version_id,
            &discovery.root_node,
            &filtered_roots,
        )
        .await?;

        // Convert to UnitEntry
        let mut units = Vec::new();
        for (i, root) in filtered_roots.into_iter().enumerate() {
            units.push(UnitEntry {
                unit_id: root.id,
                url: root.url,
                sort_order: i as i32,
                payload: serde_json::json!({ "titleNum": root.title_num }),
            });
        }
        (units, source_version_id, root_node_id)
    };

    tracing::info!("[Container] Starting ingest for {} units", units.len());

    for entry in &units {
        let unit_label = adapter.unit_label(entry);
        let result = ingest_unit(
            &client,
            &config,
            entry,
            adapter,
            &source_version_id,
            &root_node_id,
        )
        .await;

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
    source_version_id: &str,
    root_node_id: &str,
) -> Result<UnitStatus, String> {
    let accessed_at = chrono::Utc::now().to_rfc3339();
    let unit_label = adapter.unit_label(entry);

    tracing::info!("[Container] Starting ingest for {}", unit_label);

    let extract_zip = adapter.needs_zip_extraction();
    let cache = match ensure_cached(
        client,
        &entry.url,
        &config.callback_base,
        &config.callback_token,
        extract_zip,
        None,
    )
    .await?
    {
        Some(cache) => cache,
        None => {
            tracing::info!("[Container] {}: skipped (HTML response)", unit_label);
            return Ok(UnitStatus::Skipped);
        }
    };

    let xml = read_cached_file(
        client,
        &cache,
        &config.callback_base,
        &config.callback_token,
    )
    .await?;

    let build_context = BuildContext {
        source_version_id,
        root_node_id,
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

    let cache_store = HttpCache {
        client: client.clone(),
        callback_base: config.callback_base.clone(),
        callback_token: config.callback_token.clone(),
    };

    let mut context = IngestContext {
        build: build_context,
        nodes: Box::new(node_store),
        blobs: Box::new(blob_store),
        cache: Box::new(cache_store),
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
