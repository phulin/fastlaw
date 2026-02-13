use crate::runtime::cache::{ensure_cached, read_cached_file};
use crate::runtime::callbacks::{
    post_ensure_source_version, post_node_batch, post_unit_progress, post_unit_start,
};
use crate::runtime::types::{BlobStore, BuildContext, Cache, IngestContext, NodeStore, UrlQueue};
use crate::sources::adapter_for;
use crate::sources::configs::SourcesConfig;
use crate::types::{IngestConfig, NodePayload, SourceKind};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
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
    async fn fetch_cached(&self, url: &str, key: &str) -> Result<String, String> {
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

pub struct SimpleUrlQueue {
    items: Mutex<VecDeque<(String, Value)>>,
}

impl SimpleUrlQueue {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(VecDeque::new()),
        }
    }

    pub fn pop(&self) -> Option<(String, Value)> {
        let mut items = self.items.lock().unwrap();
        items.pop_front()
    }
}

impl UrlQueue for SimpleUrlQueue {
    fn enqueue(&self, url: String, metadata: Value) {
        let mut items = self.items.lock().unwrap();
        items.push_back((url, metadata));
    }
}

pub async fn ingest_source(config: IngestConfig) -> Result<(), String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|err| format!("Failed to build HTTP client: {err}"))?;
    let adapter = adapter_for(config.source);

    let queue = Arc::new(SimpleUrlQueue::new());
    let blob_store = Arc::new(DummyBlobStore);
    let cache_store = Arc::new(HttpCache {
        client: client.clone(),
        callback_base: config.callback_base.clone(),
        callback_token: config.callback_token.clone(),
    });

    // Initial seeding
    if let Some(units) = &config.units {
        for unit in units {
            queue.enqueue(
                unit.url.clone(),
                json!({
                    "type": "unit",
                    "unit_id": unit.unit_id,
                    "payload": unit.payload,
                    "sort_order": unit.sort_order
                }),
            );
        }
    } else {
        let sources_json_path =
            std::env::var("SOURCES_JSON_PATH").unwrap_or_else(|_| "../../sources.json".to_string());
        let root_url = match SourcesConfig::load_from_file(&sources_json_path) {
            Ok(config_data) => config_data
                .get_root_url(config.source)
                .map(|u| u.to_string())
                .unwrap_or_else(|| match config.source {
                    SourceKind::Usc => {
                        "https://uscode.house.gov/download/download.shtml".to_string()
                    }
                    SourceKind::Cgs => "https://www.cga.ct.gov/current/pub/titles.htm".to_string(),
                    SourceKind::Mgl => "https://malegislature.gov/Laws/GeneralLaws".to_string(),
                }),
            Err(err) => {
                tracing::warn!("Failed to load sources.json: {}. Using fallbacks.", err);
                match config.source {
                    SourceKind::Usc => {
                        "https://uscode.house.gov/download/download.shtml".to_string()
                    }
                    SourceKind::Cgs => "https://www.cga.ct.gov/current/pub/titles.htm".to_string(),
                    SourceKind::Mgl => "https://malegislature.gov/Laws/GeneralLaws".to_string(),
                }
            }
        };
        queue.enqueue(root_url, json!({ "type": "discovery" }));
    }

    let accessed_at = chrono::Utc::now().to_rfc3339();
    let mut source_version_id: Option<String> = config.source_version_id.clone();
    let mut root_node_id: Option<String> = config.root_node_id.clone();

    // Loop
    while let Some((url, metadata)) = queue.pop() {
        let task_type = metadata["type"].as_str().unwrap_or("unknown");

        if task_type == "discovery_result" {
            // Backend synchronization
            let version_id = metadata["version_id"].as_str().unwrap_or_default();
            let root_node: crate::types::NodeMeta =
                serde_json::from_value(metadata["root_node"].clone()).unwrap();

            let full_version_id = format!("{}-{}", config.source_id, version_id);
            source_version_id = Some(full_version_id.clone());
            root_node_id = Some(root_node.id.clone());

            // For discovery mode, we might need to filter enqueued units based on selectors
            // ... (selectors logic could be here if enqueued items are buffered)
            // But for now, let's just emit knowledge.

            post_ensure_source_version(
                &client,
                &config.callback_base,
                &config.callback_token,
                &config.source_id,
                &full_version_id,
                &root_node,
                &[], // unit_roots not strictly needed if we are processing enqueued units
            )
            .await?;
            continue;
        }

        let unit_id = metadata["unit_id"].as_str().unwrap_or("root");
        let unit_label = adapter.unit_label(&metadata);

        tracing::info!("[Orchestrator] Processing: {}", unit_label);

        if let (Some(svid), Some(rnid)) = (&source_version_id, &root_node_id) {
            let build_context = BuildContext {
                source_version_id: svid,
                root_node_id: rnid,
                accessed_at: &accessed_at,
                unit_sort_order: metadata["sort_order"].as_i64().unwrap_or(0) as i32,
            };

            let node_store = HttpNodeStore {
                client: client.clone(),
                callback_base: config.callback_base.clone(),
                callback_token: config.callback_token.clone(),
                unit_id: unit_id.to_string(),
                buffer: Mutex::new(Vec::with_capacity(BATCH_SIZE)),
            };

            let mut context = IngestContext {
                build: build_context,
                nodes: Box::new(node_store),
                blobs: blob_store.clone(),
                cache: cache_store.clone(),
                queue: queue.clone(),
            };

            // Only report start for unit-level tasks
            if task_type == "unit" || task_type == "part" {
                post_unit_start(
                    &client,
                    &config.callback_base,
                    &config.callback_token,
                    unit_id,
                    0,
                )
                .await?;
            }

            let result = adapter
                .process_url(&mut context, &url, metadata.clone())
                .await;

            match result {
                Ok(_) => {
                    context.nodes.flush().await?;
                    if task_type == "unit" || task_type == "part" {
                        post_unit_progress(
                            &client,
                            &config.callback_base,
                            &config.callback_token,
                            unit_id,
                            "completed",
                            None,
                        )
                        .await;
                    }
                }
                Err(err) => {
                    tracing::error!("[Orchestrator] {} failed: {}", unit_label, err);
                    if task_type == "unit" || task_type == "part" {
                        post_unit_progress(
                            &client,
                            &config.callback_base,
                            &config.callback_token,
                            unit_id,
                            "error",
                            Some(&err),
                        )
                        .await;
                    }
                }
            }
        } else if task_type == "discovery" {
            // Special case for discovery task when version is not yet known
            let build_context = BuildContext {
                source_version_id: "pending",
                root_node_id: "pending",
                accessed_at: &accessed_at,
                unit_sort_order: 0,
            };

            let node_store = HttpNodeStore {
                client: client.clone(),
                callback_base: config.callback_base.clone(),
                callback_token: config.callback_token.clone(),
                unit_id: "discovery".to_string(),
                buffer: Mutex::new(Vec::with_capacity(BATCH_SIZE)),
            };

            let mut context = IngestContext {
                build: build_context,
                nodes: Box::new(node_store),
                blobs: blob_store.clone(),
                cache: cache_store.clone(),
                queue: queue.clone(),
            };

            adapter.process_url(&mut context, &url, metadata).await?;
        }
    }

    tracing::info!("[Orchestrator] Queue drained. All tasks complete.");
    Ok(())
}
