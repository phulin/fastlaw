use async_trait::async_trait;
use ingest::runtime::types::{BlobStore, BuildContext, IngestContext, NodeStore};
use ingest::sources::cga::adapter::CgaAdapter;
use ingest::sources::SourceAdapter;
use ingest::types::{NodePayload, SectionContent, UnitEntry};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct MockNodeStore {
    nodes: Arc<Mutex<Vec<NodePayload>>>,
}

impl MockNodeStore {
    fn new() -> Self {
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

struct MockBlobStore;

#[async_trait]
#[async_trait]
impl BlobStore for MockBlobStore {
    async fn store_blob(&self, _id: &str, _content: &[u8]) -> Result<String, String> {
        Ok("blob_id".to_string())
    }
}

struct MockCache;
use ingest::runtime::types::Cache;
#[async_trait]
impl Cache for MockCache {
    async fn fetch_cached(&self, url: &str, _key: Option<&str>) -> Result<String, String> {
        Err(format!("MockCache cannot fetch: {}", url))
    }
}

fn fixtures_dir() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")
}

fn load_fixture(filename: &str) -> String {
    let path = Path::new(fixtures_dir()).join(filename);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read fixture {}: {}", path.display(), e))
}

async fn run_adapter_test(html: &str, payload: serde_json::Value, url: &str) -> Vec<NodePayload> {
    let adapter = CgaAdapter;
    let unit = UnitEntry {
        unit_id: "test".to_string(),
        url: url.to_string(),
        sort_order: 1,
        payload,
    };

    let node_store = MockNodeStore::new();
    let mut ctx = IngestContext {
        build: BuildContext {
            source_version_id: "v1",
            root_node_id: "root",
            accessed_at: "now",
            unit_sort_order: 1,
        },
        nodes: Box::new(node_store.clone()),
        blobs: Box::new(MockBlobStore),
        cache: Box::new(MockCache),
    };

    adapter
        .process_unit(&unit, &mut ctx, html)
        .await
        .expect("process_unit failed");

    let nodes = node_store.nodes.lock().unwrap().clone();
    nodes
}

#[tokio::test]
async fn adapter_emits_title_chapter_and_sections() {
    let html = load_fixture("cga_basic_chapter.htm");
    let payload = serde_json::json!({
        "titleId": "20",
        "titleName": "Professional and Occupational Licensing, Certification",
        "chapterId": "377a",
        "chapterName": "Doulas",
        "unitKind": "chapter",
        "titleSortOrder": 20,
        "chapterSortOrder": 37700001,
    });

    let nodes = run_adapter_test(
        &html,
        payload,
        "https://www.cga.ct.gov/current/pub/chap_377a.htm",
    )
    .await;

    let title = nodes
        .iter()
        .find(|node| node.meta.level_name == "title")
        .expect("title node should exist");
    assert_eq!(title.meta.id, "root/title-20");
    assert_eq!(title.meta.path.as_deref(), Some("/statutes/cgs/title/20"),);

    let chapter = nodes
        .iter()
        .find(|node| node.meta.level_name == "chapter")
        .expect("chapter node should exist");
    assert_eq!(chapter.meta.id, "root/title-20/chapter-377a");
    assert_eq!(chapter.meta.parent_id.as_deref(), Some("root/title-20"));

    let sections = nodes
        .iter()
        .filter(|node| node.meta.level_name == "section")
        .collect::<Vec<_>>();
    assert_eq!(sections.len(), 2);

    let first = sections
        .iter()
        .find(|node| node.meta.path.as_deref() == Some("/statutes/cgs/section/20-86aa"))
        .expect("first section should exist");
    assert_eq!(
        first.meta.parent_id.as_deref(),
        Some("root/title-20/chapter-377a")
    );

    let content = first.content.clone().expect("section content should exist");
    let section_content = serde_json::from_value::<SectionContent>(content)
        .expect("section content should deserialize");
    assert!(section_content.metadata.is_none());
    assert_eq!(section_content.blocks[0].type_, "body");
    let expected_body = load_fixture("cga_20-86aa.body.md");
    assert_eq!(
        section_content.blocks[0].content.as_deref(),
        Some(expected_body.trim_end())
    );
    assert!(section_content
        .blocks
        .iter()
        .any(|block| block.type_ == "history_short"));
    assert!(section_content
        .blocks
        .iter()
        .any(|block| block.type_ == "history_long"));
}

#[tokio::test]
async fn adapter_inlines_cross_references_in_body_markdown() {
    let html = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/cga_mirror/current/pub/chap_001.htm"),
    )
    .expect("chapter 001 mirror should exist");

    let payload = serde_json::json!({
        "titleId": "1",
        "titleName": "General Provisions",
        "chapterId": "001",
        "chapterName": "Construction of Statutes",
        "unitKind": "chapter",
    });

    let nodes = run_adapter_test(
        &html,
        payload,
        "https://www.cga.ct.gov/current/pub/chap_001.htm",
    )
    .await;

    let section = nodes
        .iter()
        .find(|node| node.meta.path.as_deref() == Some("/statutes/cgs/section/1-1a"))
        .expect("section 1-1a should exist");

    let content = section
        .content
        .clone()
        .expect("section content should exist");
    let section_content = serde_json::from_value::<SectionContent>(content)
        .expect("section content should deserialize");
    let body = section_content.blocks[0]
        .content
        .as_deref()
        .expect("body content should exist");

    assert!(body.contains("[42a-1-201](/statutes/cgs/section/42a-1-201)"));
    assert!(body.contains("[42a-9-109](/statutes/cgs/section/42a-9-109)"));
}

#[tokio::test]
async fn adapter_handles_article_units() {
    let html = load_fixture("cga_art_001.htm");
    let payload = serde_json::json!({
        "titleId": "42a",
        "titleName": "Uniform Commercial Code",
        "chapterId": "1",
        "chapterName": "General Provisions",
        "unitKind": "article",
    });

    let nodes = run_adapter_test(
        &html,
        payload,
        "https://www.cga.ct.gov/current/pub/art_001.htm",
    )
    .await;

    let article = nodes
        .iter()
        .find(|node| node.meta.level_name == "article")
        .expect("article node should exist");
    assert_eq!(article.meta.id, "root/title-42a/article-1");

    let section = nodes
        .iter()
        .find(|node| node.meta.path.as_deref() == Some("/statutes/cgs/section/42a-1-101"))
        .expect("42a-1-101 should exist");
    assert_eq!(
        section.meta.parent_id.as_deref(),
        Some("root/title-42a/article-1")
    );
}
