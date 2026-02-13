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
    async fn fetch_cached(&self, url: &str, key: &str) -> Result<String, String>;
}

pub trait UrlQueue: Send + Sync {
    fn enqueue(&self, url: String, metadata: Value);
}

pub struct IngestContext<'a> {
    pub build: BuildContext<'a>,
    pub nodes: Box<dyn NodeStore>,
    pub blobs: Arc<dyn BlobStore>,
    pub cache: Arc<dyn Cache>,
    pub queue: Arc<dyn UrlQueue>,
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
