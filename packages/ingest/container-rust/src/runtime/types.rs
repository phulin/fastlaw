use crate::types::NodePayload;
use async_trait::async_trait;

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
    async fn fetch_cached(&self, url: &str, key: Option<&str>) -> Result<String, String>;
}

pub struct IngestContext<'a> {
    pub build: BuildContext<'a>,
    pub nodes: Box<dyn NodeStore>,
    pub blobs: Box<dyn BlobStore>,
    pub cache: Box<dyn Cache>,
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
