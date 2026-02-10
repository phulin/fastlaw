use async_trait::async_trait;
use ingest::runtime::types::{BlobStore, BuildContext, IngestContext, NodeStore};
use ingest::sources::usc::adapter::UscAdapter;
use ingest::sources::SourceAdapter;
use ingest::types::{NodePayload, UnitEntry};
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
    };

    adapter
        .process_unit(&unit, &mut ctx, xml)
        .await
        .expect("process_unit failed");

    let nodes = node_store.nodes.lock().unwrap().clone();
    nodes
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
    assert_eq!(title.meta.id, "root/title-1");
    assert_eq!(title.meta.name.as_deref(), Some("General Provisions"));

    // Check Chapter
    let chapter = nodes
        .iter()
        .find(|n| n.meta.level_name == "chapter")
        .expect("Chapter not found");
    assert_eq!(chapter.meta.id, "root/chapter-1-ch1");
    // Parent of chapter is title?
    // DocContext tracks parents.
    assert_eq!(chapter.meta.parent_id.as_deref(), Some("root/title-1"));

    // Check Section
    let section = nodes
        .iter()
        .find(|n| n.meta.level_name == "section")
        .expect("Section not found");
    // ID logic for sections usually appends to parent?
    // Wait, adapter logic for section ID: `parent_id + "/s" + section_num`.
    // Parent of section is Chapter -> "1-ch1".
    // So ID -> "1-ch1/s1".
    assert_eq!(section.meta.id, "root/chapter-1-ch1/section-1");
    assert_eq!(
        section.meta.parent_id.as_deref(),
        Some("root/chapter-1-ch1")
    );
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
