use crate::types::NodePayload;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

pub struct BuildContext<'a> {
    pub source_version_id: &'a str,
    pub root_node_id: &'a str,
    pub accessed_at: &'a str,
    pub unit_sort_order: i32,
}

#[async_trait]
pub trait NodeStore: Send + Sync {
    async fn insert_node(&self, node: NodePayload) -> Result<(), String>;
    async fn flush(&self) -> Result<(), String>;
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn store_blob(&self, id: &str, content: &[u8]) -> Result<String, String>;
}

#[async_trait]
pub trait Cache: Send + Sync {
    async fn fetch_cached(
        &self,
        url: &str,
        key: &str,
        throttle_requests_per_second: Option<u32>,
    ) -> Result<String, String>;
}

#[derive(Debug, Clone)]
pub struct QueueItem {
    pub url: String,
    pub parent_id: String,
    pub level_name: String,
    pub level_index: i32,
    pub metadata: Value,
}

pub trait UrlQueue: Send + Sync {
    fn enqueue(&self, item: QueueItem);
}

#[async_trait]
pub trait Logger: Send + Sync {
    async fn log(&self, level: &str, message: &str, context: Option<Value>);
}

pub struct IngestContext<'a> {
    pub build: BuildContext<'a>,
    pub nodes: Box<dyn NodeStore>,
    pub blobs: Arc<dyn BlobStore>,
    pub cache: Arc<dyn Cache>,
    pub queue: Arc<dyn UrlQueue>,
    pub logger: Arc<dyn Logger>,
}

pub enum UnitStatus {
    Completed,
    Skipped,
}

impl UnitStatus {
    pub fn as_str(&self) -> &str {
        match self {
            UnitStatus::Completed => "completed",
            UnitStatus::Skipped => "skipped",
        }
    }
}
