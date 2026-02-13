use async_trait::async_trait;
use ingest::runtime::types::{BlobStore, BuildContext, IngestContext, NodeStore};
use ingest::sources::usc::adapter::UscAdapter;
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
impl BlobStore for MockBlobStore {
    async fn store_blob(&self, _id: &str, _content: &[u8]) -> Result<String, String> {
        Ok("blob_id".to_string())
    }
}

struct MockCache;
use ingest::runtime::types::Cache;
#[async_trait]
impl Cache for MockCache {
    async fn fetch_cached(&self, url: &str, _key: &str) -> Result<String, String> {
        Err(format!("MockCache cannot fetch: {}", url))
    }
}

async fn run_adapter_test(xml: &str, title_num: &str) -> Vec<NodePayload> {
    let adapter = UscAdapter;
    let unit = UnitEntry {
        unit_id: "test".to_string(),
        url: "http://example.com".to_string(),
        sort_order: 1,
        payload: serde_json::json!({ "titleNum": title_num }),
    };

    let node_store = MockNodeStore::new();
    let blob_store = MockBlobStore;
    let build_ctx = BuildContext {
        source_version_id: "v1",
        root_node_id: "root",
        accessed_at: "now",
        unit_sort_order: 1,
    };

    let mut ctx = IngestContext {
        build: build_ctx,
        nodes: Box::new(node_store.clone()),
        blobs: Box::new(blob_store),
        cache: Box::new(MockCache),
    };

    adapter
        .process_unit(&unit, &mut ctx, xml)
        .await
        .expect("process_unit failed");

    let nodes = node_store.nodes.lock().unwrap().clone();
    nodes
}

fn fixtures_dir() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")
}

fn load_fixture(filename: &str) -> String {
    let path = Path::new(fixtures_dir()).join(filename);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read fixture {}: {}", path.display(), e))
}

#[tokio::test]
async fn test_adapter_extracts_levels_and_sections() {
    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t1">
            <meta><title>Title 1</title></meta>
            <main>
                <title identifier="/us/usc/t1">
                    <num value="1">Title 1</num>
                    <heading>General Provisions</heading>
                    <chapter identifier="/us/usc/t1/ch1">
                        <num value="1">Chapter 1</num>
                        <heading>Rules of Construction</heading>
                        <section identifier="/us/usc/t1/s1">
                             <num value="1">§ 1.</num>
                             <heading>Words denoting number, gender, etc.</heading>
                             <content>In determining the meaning of any Act of Congress...</content>
                        </section>
                    </chapter>
                </title>
            </main>
        </uscDoc>"#;

    let nodes = run_adapter_test(xml, "1").await;

    // We expect:
    // 1. Title Level (1-title)
    // 2. Chapter Level (1-ch1)
    // 3. Section Node (1/s1 or similar ID logic)

    // Check Title
    let title = nodes
        .iter()
        .find(|n| n.meta.level_name == "title")
        .expect("Title not found");
    assert_eq!(title.meta.id, "root/t1/root");
    assert_eq!(title.meta.name.as_deref(), Some("General Provisions"));

    // Check Chapter
    let chapter = nodes
        .iter()
        .find(|n| n.meta.level_name == "chapter")
        .expect("Chapter not found");
    assert_eq!(chapter.meta.id, "root/t1/ch1");
    assert_eq!(chapter.meta.parent_id.as_deref(), Some("root/t1/root"));

    // Check Section
    let section = nodes
        .iter()
        .find(|n| n.meta.level_name == "section")
        .expect("Section not found");
    assert_eq!(section.meta.id, "root/t1/ch1/section-1");
    assert_eq!(section.meta.parent_id.as_deref(), Some("root/t1/ch1"));
    assert_eq!(
        section.meta.name.as_deref(),
        Some("Words denoting number, gender, etc.")
    );

    // Check Section Content
    let content = section.content.as_ref().expect("Section must have content");
    // Verify body text
    let content_json = content.to_string();
    assert!(content_json.contains("In determining the meaning"));
}

#[tokio::test]
async fn test_adapter_matches_42_usc_302_nodepayload() {
    let xml = load_fixture("usc42_s302.xml");

    let nodes = run_adapter_test(&xml, "42").await;
    let node = nodes
        .iter()
        .find(|n| n.meta.path.as_deref() == Some("/statutes/usc/section/42/302"))
        .expect("42 USC 302 node not found");

    assert_eq!(node.meta.id, "root/t42/ch7/schI/section-302");
    assert_eq!(node.meta.level_name, "section");
    assert_eq!(node.meta.level_index, 8);
    assert_eq!(node.meta.name.as_deref(), Some("State old-age plans"));
    assert_eq!(node.meta.parent_id.as_deref(), Some("root/t42/ch7/schI"));
    assert_eq!(
        node.meta.path.as_deref(),
        Some("/statutes/usc/section/42/302")
    );
    assert_eq!(node.meta.readable_id.as_deref(), Some("42 USC 302"));
    assert_eq!(node.meta.heading_citation.as_deref(), Some("42 USC 302"));
    assert_eq!(node.meta.source_url, None);
    assert_eq!(node.meta.accessed_at.as_deref(), Some("now"));

    let content = node.content.clone().expect("section content should exist");
    let section_content = serde_json::from_value::<SectionContent>(content)
        .expect("section content should deserialize");
    assert!(
        section_content.metadata.is_none(),
        "cross-reference metadata should not be stored in content",
    );

    let blocks = &section_content.blocks;
    assert_eq!(blocks.len(), 16);

    assert_eq!(blocks[0].type_, "body");
    assert_eq!(blocks[0].label, None);
    let body = blocks[0]
        .content
        .as_deref()
        .expect("body content should exist");
    let expected_body = load_fixture("usc42_s302.body.md");
    assert_eq!(body, expected_body.trim_end());

    assert_eq!(blocks[1].type_, "source_credit");
    assert_eq!(blocks[1].label.as_deref(), Some("Source Credit"));
    assert!(blocks[1]
        .content
        .as_deref()
        .is_some_and(|content| content.contains("Aug. 14, 1935")));

    assert_eq!(blocks[2].type_, "note");
    assert_eq!(blocks[2].label.as_deref(), Some("Repeal of Section"));
    assert!(blocks[2]
        .content
        .as_deref()
        .is_some_and(|content| content.contains("repealed effective")));

    assert_eq!(blocks[3].type_, "heading");
    assert_eq!(blocks[3].label.as_deref(), Some("Editorial Notes"));
    assert_eq!(blocks[3].content, None);

    assert_eq!(blocks[4].type_, "amendments");
    assert_eq!(blocks[4].label.as_deref(), Some("Amendments"));
    assert!(blocks[4]
        .content
        .as_deref()
        .is_some_and(|content| !content.starts_with("**Amendments**")));

    assert_eq!(blocks[5].type_, "heading");
    assert_eq!(
        blocks[5].label.as_deref(),
        Some("Statutory Notes and Related Subsidiaries"),
    );
    assert_eq!(blocks[5].content, None);

    let note_labels = blocks[6..]
        .iter()
        .map(|block| block.label.as_deref().unwrap_or(""))
        .collect::<Vec<_>>();
    assert_eq!(
        note_labels,
        vec![
            "Effective Date of 1984 Amendment",
            "Effective Date of 1968 Amendment",
            "Effective Date of 1965 Amendment",
            "Effective Date of 1962 Amendment",
            "Effective Date of 1960 Amendment",
            "Effective Date of 1958 Amendment",
            "Effective Date of 1956 Amendment",
            "Effective Date of 1950 Amendment",
            "Transfer of Functions",
            "Disregarding of Income of OASDI Recipients in Determining Need for Public Assistance",
        ],
    );
}
