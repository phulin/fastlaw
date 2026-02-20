use crate::runtime::cache::{ensure_cached, read_cached_file};
use crate::runtime::callbacks::{
    post_ensure_source_version, post_node_batch, post_unit_progress, post_unit_start,
};
use crate::runtime::fetcher::HttpFetcher;
use crate::runtime::logging::{log_event_with_callback, LogLevel};
use crate::runtime::types::{
    BlobStore, BuildContext, Cache, IngestContext, Logger, NodeStore, QueueItem, UrlQueue,
};
use crate::sources::adapter_for;
use crate::sources::configs::SourcesConfig;
use crate::types::{IngestConfig, NodePayload};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const BATCH_SIZE: usize = 200;

struct HttpNodeStore {
    client: Client,
    callback_base: String,
    callback_token: String,
    unit_id: String,
    unit_buffers: Arc<Mutex<HashMap<String, Vec<NodePayload>>>>,
}

#[async_trait]
impl NodeStore for HttpNodeStore {
    async fn insert_node(&self, node: NodePayload) -> Result<(), String> {
        let batch = {
            let mut unit_buffers = self.unit_buffers.lock().map_err(|e| e.to_string())?;
            let buffer = unit_buffers
                .entry(self.unit_id.clone())
                .or_insert_with(|| Vec::with_capacity(BATCH_SIZE));
            buffer.push(node);
            if buffer.len() >= BATCH_SIZE {
                Some(std::mem::take(buffer))
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
            let mut unit_buffers = self.unit_buffers.lock().map_err(|e| e.to_string())?;
            unit_buffers.get_mut(&self.unit_id).and_then(|buffer| {
                if buffer.is_empty() {
                    None
                } else {
                    Some(std::mem::take(buffer))
                }
            })
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
            url.to_lowercase().ends_with(".zip"),
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

struct HttpLogger {
    client: Client,
    callback_base: String,
    callback_token: String,
}

#[async_trait]
impl Logger for HttpLogger {
    async fn log(&self, level: &str, message: &str, context: Option<serde_json::Value>) {
        let log_level = match level {
            "debug" => LogLevel::Debug,
            "info" => LogLevel::Info,
            "warn" => LogLevel::Warn,
            "error" => LogLevel::Error,
            _ => LogLevel::Info,
        };

        log_event_with_callback(
            &self.client,
            Some(&self.callback_base),
            Some(&self.callback_token),
            log_level,
            message,
            context,
        )
        .await;
    }
}

pub struct SimpleUrlQueue {
    items: Mutex<VecDeque<QueueItem>>,
}

impl SimpleUrlQueue {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(VecDeque::new()),
        }
    }

    pub fn pop(&self) -> Option<QueueItem> {
        let mut items = self.items.lock().unwrap();
        items.pop_front()
    }
}

impl UrlQueue for SimpleUrlQueue {
    fn enqueue(&self, item: QueueItem) {
        let mut items = self.items.lock().unwrap();
        items.push_back(item);
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

    let logger = Arc::new(HttpLogger {
        client: client.clone(),
        callback_base: config.callback_base.clone(),
        callback_token: config.callback_token.clone(),
    });

    let accessed_at = chrono::Utc::now().to_rfc3339();
    let mut source_version_id: Option<String> = config.source_version_id.clone();
    let mut root_node_id: Option<String> = config.root_node_id.clone();
    let unit_buffers = Arc::new(Mutex::new(HashMap::<String, Vec<NodePayload>>::new()));
    let mut started_units: Vec<String> = Vec::new();
    let mut started_unit_ids: HashSet<String> = HashSet::new();
    let mut failed_units: HashSet<String> = HashSet::new();

    // Initial seeding
    if let Some(units) = &config.units {
        let rnid = config
            .root_node_id
            .as_deref()
            .unwrap_or_default()
            .to_string();
        for unit in units {
            queue.enqueue(QueueItem {
                url: unit.url.clone(),
                parent_id: rnid.clone(),
                level_name: "unit".to_string(),
                level_index: 0,
                metadata: json!({
                    "unit_id": unit.unit_id,
                    "sort_order": unit.sort_order
                }),
            });
        }
    } else {
        // Discovery mode: fetch root URL, discover units, sync with backend
        let config_data = SourcesConfig::load_default().expect("Failed to load sources.json");
        let root_url = config_data
            .get_root_url(config.source)
            .expect("Missing root URL in sources.json")
            .to_string();

        let fetcher = HttpFetcher::new(client.clone());
        let discovery = adapter
            .discover(&fetcher, &root_url, config.manual_start_url.as_deref())
            .await?;

        let full_version_id = format!("{}-{}", config.source_id, discovery.version_id);
        source_version_id = Some(full_version_id.clone());
        root_node_id = Some(discovery.root_node.id.clone());

        post_ensure_source_version(
            &client,
            &config.callback_base,
            &config.callback_token,
            &config.source_id,
            &full_version_id,
            &discovery.root_node,
            &discovery.unit_roots,
        )
        .await?;

        let rnid = discovery.root_node.id.clone();
        for (i, root) in discovery.unit_roots.into_iter().enumerate() {
            queue.enqueue(QueueItem {
                url: root.url,
                parent_id: rnid.clone(),
                level_name: root.level_name,
                level_index: root.level_index,
                metadata: json!({
                    "unit_id": root.id,
                    "title_num": root.title_num,
                    "sort_order": i as i32
                }),
            });
        }
    }

    // Main processing loop
    while let Some(item) = queue.pop() {
        let unit_id = item.metadata["unit_id"]
            .as_str()
            .unwrap_or("root")
            .to_string();
        let unit_label = adapter.unit_label(&item);

        let (Some(svid), Some(rnid)) = (&source_version_id, &root_node_id) else {
            return Err(format!(
                "source_version_id/root_node_id not set when processing: {}",
                item.level_name
            ));
        };

        let is_unit_root = item.parent_id == *rnid;

        tracing::info!("[Orchestrator] Processing: {}", unit_label);

        let build_context = BuildContext {
            source_version_id: svid,
            root_node_id: rnid,
            accessed_at: &accessed_at,
            unit_sort_order: item.metadata["sort_order"].as_i64().unwrap_or(0) as i32,
        };

        let node_store = HttpNodeStore {
            client: client.clone(),
            callback_base: config.callback_base.clone(),
            callback_token: config.callback_token.clone(),
            unit_id: unit_id.clone(),
            unit_buffers: unit_buffers.clone(),
        };

        let mut context = IngestContext {
            build: build_context,
            nodes: Box::new(node_store),
            blobs: blob_store.clone(),
            cache: cache_store.clone(),
            queue: queue.clone(),
            logger: logger.clone(),
        };

        // Only report start for unit-level tasks (direct children of root)
        if is_unit_root && started_unit_ids.insert(unit_id.clone()) {
            started_units.push(unit_id.clone());
            post_unit_start(
                &client,
                &config.callback_base,
                &config.callback_token,
                &unit_id,
                0,
            )
            .await?;
        }

        let result = adapter.process_url(&mut context, &item).await;

        match result {
            Ok(_) => {}
            Err(err) => {
                tracing::error!("[Orchestrator] {} failed: {}", unit_label, err);
                if failed_units.insert(unit_id.clone()) {
                    post_unit_progress(
                        &client,
                        &config.callback_base,
                        &config.callback_token,
                        &unit_id,
                        "error",
                        Some(&err),
                    )
                    .await;
                }
            }
        }
    }

    for unit_id in &started_units {
        let node_store = HttpNodeStore {
            client: client.clone(),
            callback_base: config.callback_base.clone(),
            callback_token: config.callback_token.clone(),
            unit_id: unit_id.clone(),
            unit_buffers: unit_buffers.clone(),
        };
        node_store.flush().await?;
    }

    for unit_id in started_units {
        if failed_units.contains(&unit_id) {
            continue;
        }
        post_unit_progress(
            &client,
            &config.callback_base,
            &config.callback_token,
            &unit_id,
            "completed",
            None,
        )
        .await;
    }

    tracing::info!("[Orchestrator] Queue drained. All tasks complete.");
    Ok(())
}
