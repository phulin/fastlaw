#![allow(dead_code)]
use async_trait::async_trait;
use ingest::runtime::fetcher::Fetcher;
use ingest::runtime::types::{
    BlobStore, BuildContext, Cache, IngestContext, NodeStore, QueueItem, UrlQueue,
};
use ingest::types::NodePayload;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub fn fixtures_dir() -> String {
    format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"))
}

pub fn load_fixture(filename: &str) -> String {
    let path = Path::new(&fixtures_dir()).join(filename);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read fixture {}: {}", path.display(), e))
}

#[derive(Clone)]
pub struct MockNodeStore {
    pub nodes: Arc<Mutex<Vec<NodePayload>>>,
}

impl MockNodeStore {
    pub fn new() -> Self {
        Self {
            nodes: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[async_trait]
impl NodeStore for MockNodeStore {
    async fn insert_node(&self, node: NodePayload) -> Result<(), String> {
        self.nodes.lock().unwrap().push(node);
        Ok(())
    }
    async fn flush(&self) -> Result<(), String> {
        Ok(())
    }
}

pub struct MockBlobStore;
#[async_trait]
impl BlobStore for MockBlobStore {
    async fn store_blob(&self, _id: &str, _content: &[u8]) -> Result<String, String> {
        Ok("blob_id".to_string())
    }
}

pub struct MockCache {
    pub fixtures: Arc<Mutex<HashMap<String, String>>>,
}

impl MockCache {
    pub fn new() -> Self {
        Self {
            fixtures: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn add_fixture(&self, url: &str, content: &str) {
        self.fixtures
            .lock()
            .unwrap()
            .insert(url.to_string(), content.to_string());
    }
}

#[async_trait]
impl Cache for MockCache {
    async fn fetch_cached(&self, url: &str, _key: &str) -> Result<String, String> {
        self.fixtures
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| format!("No fixture for URL: {}", url))
    }
}

pub struct MockFetcher {
    pub fixtures: HashMap<String, String>,
}

impl MockFetcher {
    pub fn new() -> Self {
        Self {
            fixtures: HashMap::new(),
        }
    }

    pub fn add_fixture(&mut self, url: &str, content: &str) {
        self.fixtures.insert(url.to_string(), content.to_string());
    }
}

#[async_trait]
impl Fetcher for MockFetcher {
    async fn fetch(&self, url: &str) -> Result<String, String> {
        self.fixtures
            .get(url)
            .cloned()
            .ok_or_else(|| format!("MockFetcher: No fixture for URL: {}", url))
    }
}

pub struct MockUrlQueue {
    pub enqueued: Arc<Mutex<VecDeque<QueueItem>>>,
}

impl MockUrlQueue {
    pub fn new() -> Self {
        Self {
            enqueued: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

impl UrlQueue for MockUrlQueue {
    fn enqueue(&self, item: QueueItem) {
        self.enqueued.lock().unwrap().push_back(item);
    }
}

pub struct MockLogger;

use ingest::runtime::types::Logger;

#[async_trait]
impl Logger for MockLogger {
    async fn log(&self, _level: &str, _message: &str, _context: Option<serde_json::Value>) {}
}

pub fn create_test_context<'a>(
    node_store: MockNodeStore,
    cache: MockCache,
    queue: MockUrlQueue,
    source_version_id: &'a str,
    root_node_id: &'a str,
) -> IngestContext<'a> {
    IngestContext {
        build: BuildContext {
            source_version_id,
            root_node_id,
            accessed_at: "2024-01-01",
            unit_sort_order: 1,
        },
        nodes: Box::new(node_store),
        blobs: Arc::new(MockBlobStore),
        cache: Arc::new(cache),
        queue: Arc::new(queue),
        logger: Arc::new(MockLogger),
    }
}

use ingest::sources::SourceAdapter;

pub struct AdapterTestContext<'a, A: SourceAdapter> {
    pub adapter: A,
    pub node_store: MockNodeStore,
    pub cache: MockCache,
    pub queue: MockUrlQueue,
    pub source_version_id: String,
    pub root_node_id: String,
    pub _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a, A: SourceAdapter> AdapterTestContext<'a, A> {
    pub fn new(adapter: A, root_node_id: &str) -> Self {
        Self {
            adapter,
            node_store: MockNodeStore::new(),
            cache: MockCache::new(),
            queue: MockUrlQueue::new(),
            source_version_id: "v1".to_string(),
            root_node_id: root_node_id.to_string(),
            _marker: std::marker::PhantomData,
        }
    }

    pub fn add_fixture(&self, url: &str, content: &str) {
        self.cache.add_fixture(url, content);
    }

    pub async fn run_item(&mut self, initial_item: QueueItem) {
        let queue_items = self.queue.enqueued.clone();

        let mut ctx = create_test_context(
            self.node_store.clone(),
            MockCache {
                fixtures: self.cache.fixtures.clone(),
            },
            MockUrlQueue {
                enqueued: queue_items.clone(),
            },
            &self.source_version_id,
            &self.root_node_id,
        );

        // Enqueue the initial item
        queue_items.lock().unwrap().push_back(initial_item);

        // Processing loop mimicking the orchestrator
        loop {
            let item = {
                let mut q = queue_items.lock().unwrap();
                q.pop_front()
            };

            match item {
                Some(item) => {
                    self.adapter
                        .process_url(&mut ctx, &item)
                        .await
                        .expect("process_url failed");
                }
                None => break,
            }
        }
    }

    pub fn expect_node(&self, id: &str) -> NodeMatcher {
        let nodes = self.node_store.nodes.lock().unwrap();
        let node = nodes
            .iter()
            .find(|n| n.meta.id == id)
            .cloned()
            .unwrap_or_else(|| {
                let available_ids: Vec<_> = nodes.iter().map(|n| &n.meta.id).collect();
                panic!(
                    "Node with id '{}' not found. Available nodes: {:?}",
                    id, available_ids
                )
            });
        NodeMatcher { node }
    }

    pub fn get_nodes(&self) -> Vec<NodePayload> {
        self.node_store.nodes.lock().unwrap().clone()
    }
}

pub struct NodeMatcher {
    pub node: NodePayload,
}

impl NodeMatcher {
    pub fn level(self, level: &str) -> Self {
        assert_eq!(
            self.node.meta.level_name, level,
            "Level mismatch for node {}",
            self.node.meta.id
        );
        self
    }

    pub fn parent(self, parent_id: &str) -> Self {
        assert_eq!(
            self.node.meta.parent_id.as_deref(),
            Some(parent_id),
            "Parent ID mismatch for node {}",
            self.node.meta.id
        );
        self
    }

    pub fn path(self, path: &str) -> Self {
        assert_eq!(
            self.node.meta.path.as_deref(),
            Some(path),
            "Path mismatch for node {}",
            self.node.meta.id
        );
        self
    }

    pub fn name(self, name: &str) -> Self {
        assert_eq!(
            self.node.meta.name.as_deref(),
            Some(name),
            "Name mismatch for node {}",
            self.node.meta.id
        );
        self
    }

    pub fn readable_id(self, readable_id: &str) -> Self {
        assert_eq!(
            self.node.meta.readable_id.as_deref(),
            Some(readable_id),
            "Readable ID mismatch for node {}",
            self.node.meta.id
        );
        self
    }

    pub fn heading_citation(self, citation: &str) -> Self {
        assert_eq!(
            self.node.meta.heading_citation.as_deref(),
            Some(citation),
            "Heading citation mismatch for node {}",
            self.node.meta.id
        );
        self
    }

    pub fn content_contains(self, text: &str) -> Self {
        let content = self.node.content.as_ref().expect("Node has no content");
        let content_str = serde_json::to_string(content).unwrap();
        assert!(
            content_str.contains(text),
            "Content does not contain '{}' for node {}",
            text,
            self.node.meta.id
        );
        self
    }
}
