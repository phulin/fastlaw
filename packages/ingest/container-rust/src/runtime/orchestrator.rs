use crate::runtime::cache::ensure_cached;
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
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const BATCH_SIZE: usize = 200;
const UNIT_CONCURRENCY: usize = 8;

#[derive(Clone)]
struct HttpNodeStore {
    client: Client,
    callback_base: String,
    callback_token: String,
    unit_id: String,
    buffer: Arc<Mutex<Vec<NodePayload>>>,
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
            if buffer.is_empty() {
                None
            } else {
                Some(std::mem::take(&mut *buffer))
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
    async fn fetch_cached(
        &self,
        url: &str,
        key: &str,
        throttle_requests_per_second: Option<u32>,
    ) -> Result<String, String> {
        let cache_result = ensure_cached(
            &self.client,
            url,
            &self.callback_base,
            &self.callback_token,
            url.to_lowercase().ends_with(".zip"),
            key,
            throttle_requests_per_second,
        )
        .await?;

        cache_result.ok_or_else(|| {
            format!(
                "Cache proxy returned 422 for URL (likely HTML response): {}",
                url
            )
        })
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

fn create_unit_roots(config: &IngestConfig, root_node_id: &str) -> Vec<QueueItem> {
    if let Some(units) = &config.units {
        return units
            .iter()
            .map(|unit| QueueItem {
                url: unit.url.clone(),
                parent_id: root_node_id.to_string(),
                level_name: "unit".to_string(),
                level_index: 0,
                metadata: json!({
                    "unit_id": unit.unit_id,
                    "sort_order": unit.sort_order,
                }),
            })
            .collect();
    }

    Vec::new()
}

async fn process_unit_root(
    adapter: &'static (dyn crate::sources::SourceAdapter + Send + Sync),
    client: Client,
    callback_base: String,
    callback_token: String,
    source_version_id: String,
    root_node_id: String,
    accessed_at: String,
    blob_store: Arc<dyn BlobStore>,
    cache_store: Arc<dyn Cache>,
    logger: Arc<dyn Logger>,
    unit_root: QueueItem,
) -> Result<(), String> {
    let unit_id = unit_root.metadata["unit_id"]
        .as_str()
        .unwrap_or("root")
        .to_string();
    let unit_label = adapter.unit_label(&unit_root);
    let unit_sort_order = unit_root.metadata["sort_order"].as_i64().unwrap_or(0) as i32;

    post_unit_start(&client, &callback_base, &callback_token, &unit_id, 0).await?;

    let queue = Arc::new(SimpleUrlQueue::new());
    queue.enqueue(unit_root);

    let node_store = HttpNodeStore {
        client: client.clone(),
        callback_base: callback_base.clone(),
        callback_token: callback_token.clone(),
        unit_id: unit_id.clone(),
        buffer: Arc::new(Mutex::new(Vec::with_capacity(BATCH_SIZE))),
    };

    while let Some(item) = queue.pop() {
        let build_context = BuildContext {
            source_version_id: &source_version_id,
            root_node_id: &root_node_id,
            accessed_at: &accessed_at,
            unit_sort_order,
        };

        let mut context = IngestContext {
            build: build_context,
            nodes: Box::new(node_store.clone()),
            blobs: blob_store.clone(),
            cache: cache_store.clone(),
            queue: queue.clone(),
            logger: logger.clone(),
        };

        if let Err(err) = adapter.process_url(&mut context, &item).await {
            tracing::error!("[Orchestrator] {} failed: {}", unit_label, err);
            node_store.flush().await?;
            post_unit_progress(
                &client,
                &callback_base,
                &callback_token,
                &unit_id,
                "error",
                Some(&err),
            )
            .await;
            return Ok(());
        }
    }

    node_store.flush().await?;
    post_unit_progress(
        &client,
        &callback_base,
        &callback_token,
        &unit_id,
        "completed",
        None,
    )
    .await;

    Ok(())
}

pub async fn ingest_source(config: IngestConfig) -> Result<(), String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|err| format!("Failed to build HTTP client: {err}"))?;

    let adapter = adapter_for(config.source);

    let blob_store: Arc<dyn BlobStore> = Arc::new(DummyBlobStore);
    let cache_store: Arc<dyn Cache> = Arc::new(HttpCache {
        client: client.clone(),
        callback_base: config.callback_base.clone(),
        callback_token: config.callback_token.clone(),
    });

    let logger: Arc<dyn Logger> = Arc::new(HttpLogger {
        client: client.clone(),
        callback_base: config.callback_base.clone(),
        callback_token: config.callback_token.clone(),
    });

    let accessed_at = chrono::Utc::now().to_rfc3339();
    let mut source_version_id: Option<String> = config.source_version_id.clone();
    let mut root_node_id: Option<String> = config.root_node_id.clone();

    let mut unit_roots = if let Some(root_id) = &root_node_id {
        create_unit_roots(&config, root_id)
    } else {
        Vec::new()
    };

    if unit_roots.is_empty() {
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

        let parent_id = discovery.root_node.id;
        unit_roots = discovery
            .unit_roots
            .into_iter()
            .enumerate()
            .map(|(idx, root)| QueueItem {
                url: root.url,
                parent_id: parent_id.clone(),
                level_name: root.level_name,
                level_index: root.level_index,
                metadata: json!({
                    "unit_id": root.id,
                    "title_num": root.title_num,
                    "sort_order": idx as i32,
                }),
            })
            .collect();
    }

    let (Some(source_version_id), Some(root_node_id)) = (source_version_id, root_node_id) else {
        return Err("source_version_id/root_node_id not set after discovery".to_string());
    };

    let semaphore = Arc::new(Semaphore::new(UNIT_CONCURRENCY));
    let mut tasks = JoinSet::new();

    for unit_root in unit_roots {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|err| format!("Failed to acquire unit permit: {err}"))?;

        let callback_base = config.callback_base.clone();
        let callback_token = config.callback_token.clone();
        let source_version_id = source_version_id.clone();
        let root_node_id = root_node_id.clone();
        let accessed_at = accessed_at.clone();
        let client = client.clone();
        let blob_store = blob_store.clone();
        let cache_store = cache_store.clone();
        let logger = logger.clone();

        tasks.spawn(async move {
            let _permit = permit;
            process_unit_root(
                adapter,
                client,
                callback_base,
                callback_token,
                source_version_id,
                root_node_id,
                accessed_at,
                blob_store,
                cache_store,
                logger,
                unit_root,
            )
            .await
        });
    }

    while let Some(join_result) = tasks.join_next().await {
        match join_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(format!("Unit task failed to join: {err}")),
        }
    }

    tracing::info!("[Orchestrator] All unit tasks complete.");
    Ok(())
}
