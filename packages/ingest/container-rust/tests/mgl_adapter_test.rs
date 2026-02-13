use async_trait::async_trait;
use ingest::runtime::types::{BlobStore, BuildContext, Cache, IngestContext, NodeStore};
use ingest::sources::mgl::adapter::MglAdapter;
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

struct MockCache {
    fixtures: Arc<Mutex<std::collections::HashMap<String, String>>>,
}

impl MockCache {
    fn new() -> Self {
        Self {
            fixtures: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn add_fixture(&self, url: String, content: String) {
        self.fixtures.lock().unwrap().insert(url, content);
    }
}

#[async_trait]
impl Cache for MockCache {
    async fn fetch_cached(&self, url: &str, _key: Option<&str>) -> Result<String, String> {
        self.fixtures
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| format!("No fixture for URL: {}", url))
    }
}

async fn run_adapter_test(
    part_json: &str,
    part_code: &str,
    chapter_fixtures: Vec<(String, String)>,
) -> Vec<NodePayload> {
    let adapter = MglAdapter;
    let unit = UnitEntry {
        unit_id: "test".to_string(),
        url: "http://example.com".to_string(),
        sort_order: 1,
        payload: serde_json::json!({ "titleNum": part_code }),
    };

    let node_store = MockNodeStore::new();
    let blob_store = MockBlobStore;
    let cache = MockCache::new();

    // Add chapter fixtures to cache
    for (url, content) in chapter_fixtures {
        cache.add_fixture(url, content);
    }

    let build_ctx = BuildContext {
        source_version_id: "v1",
        root_node_id: "mgl/v1/root",
        accessed_at: "now",
        unit_sort_order: 1,
    };

    let mut ctx = IngestContext {
        build: build_ctx,
        nodes: Box::new(node_store.clone()),
        blobs: Box::new(blob_store),
        cache: Box::new(cache),
    };

    adapter
        .process_unit(&unit, &mut ctx, part_json)
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
async fn test_adapter_extracts_part_chapter_and_sections() {
    let part_json = load_fixture("mgl_part_i.json");
    let chapter_json = load_fixture("mgl_chapter_1_full.json");

    let chapter_fixtures = vec![(
        "https://malegislature.gov/api/Chapters/1".to_string(),
        chapter_json,
    )];

    let nodes = run_adapter_test(&part_json, "I", chapter_fixtures).await;

    // Check Part node
    let part = nodes
        .iter()
        .find(|n| n.meta.level_name == "part")
        .expect("Part not found");
    assert_eq!(part.meta.id, "mgl/v1/root/part-i");
    assert_eq!(part.meta.readable_id.as_deref(), Some("Part I"));

    // Check Chapter node
    let chapter = nodes
        .iter()
        .find(|n| n.meta.level_name == "chapter")
        .expect("Chapter not found");
    assert_eq!(chapter.meta.id, "mgl/v1/root/part-i/chapter-1");
    assert_eq!(
        chapter.meta.parent_id.as_deref(),
        Some("mgl/v1/root/part-i")
    );
    assert_eq!(chapter.meta.name.as_deref(), Some("JURISDICTION"));

    // Check Section nodes
    let sections: Vec<_> = nodes
        .iter()
        .filter(|n| n.meta.level_name == "section")
        .collect();
    assert_eq!(sections.len(), 3);

    // Check section 7A
    let section_7a = sections
        .iter()
        .find(|s| s.meta.id.contains("section-7a"))
        .expect("Section 7A not found");
    assert_eq!(
        section_7a.meta.parent_id.as_deref(),
        Some("mgl/v1/root/part-i/chapter-1")
    );
    assert_eq!(section_7a.meta.readable_id.as_deref(), Some("7A"));
    assert_eq!(
        section_7a.meta.heading_citation.as_deref(),
        Some("MGL c.1 §7A")
    );
}

#[tokio::test]
async fn test_adapter_section_body_matches_expected_markdown() {
    let part_json = load_fixture("mgl_part_i.json");
    let chapter_json = load_fixture("mgl_chapter_1_full.json");

    let chapter_fixtures = vec![(
        "https://malegislature.gov/api/Chapters/1".to_string(),
        chapter_json,
    )];

    let nodes = run_adapter_test(&part_json, "I", chapter_fixtures).await;

    // Find section 7A
    let section_7a = nodes
        .iter()
        .find(|n| n.meta.id.contains("section-7a"))
        .expect("Section 7A not found");

    // Check content
    let content = section_7a
        .content
        .as_ref()
        .expect("Section must have content");
    let section_content: SectionContent = serde_json::from_value(content.clone())
        .expect("Content should deserialize to SectionContent");

    assert_eq!(section_content.blocks.len(), 1);
    assert_eq!(section_content.blocks[0].type_, "body");

    let body = section_content.blocks[0]
        .content
        .as_deref()
        .expect("Body content should exist");

    let expected_body = load_fixture("mgl_chapter_1_section_7a.body.md");
    assert_eq!(body.trim_end(), expected_body.trim_end());
}

#[tokio::test]
async fn test_adapter_fetches_individual_section_when_text_missing() {
    let part_json = load_fixture("mgl_part_i.json");
    let chapter_json = load_fixture("mgl_chapter_1_no_text.json");
    let section_json = load_fixture("mgl_section_1.json");

    let chapter_fixtures = vec![
        (
            "https://malegislature.gov/api/Chapters/1".to_string(),
            chapter_json,
        ),
        (
            "https://malegislature.gov/api/Chapters/1/Sections/1".to_string(),
            section_json,
        ),
    ];

    let nodes = run_adapter_test(&part_json, "I", chapter_fixtures).await;

    // Find section 1
    let section_1 = nodes
        .iter()
        .find(|n| n.meta.id.contains("section-1"))
        .expect("Section 1 not found");

    // Check content
    let content = section_1
        .content
        .as_ref()
        .expect("Section must have content");
    let section_content: SectionContent = serde_json::from_value(content.clone())
        .expect("Content should deserialize to SectionContent");

    let body = section_content.blocks[0]
        .content
        .as_deref()
        .expect("Body content should exist");

    assert!(body.contains("The jurisdiction of the commonwealth shall extend"));
}

mod parser_tests {
    use ingest::sources::mgl::parser::{
        designator_sort_order, normalize_designator, parse_chapter_detail, parse_section_content,
        MglApiChapter, MglApiSection,
    };

    #[test]
    fn test_designator_sort_order() {
        assert!(designator_sort_order("2A") > designator_sort_order("2"));
        assert!(designator_sort_order("10") > designator_sort_order("2A"));
    }

    #[test]
    fn test_normalize_designator() {
        assert_eq!(normalize_designator("  7a  "), "7A");
        assert_eq!(normalize_designator("7A"), "7A");
    }

    #[test]
    fn test_parse_chapter_detail() {
        let chapter = MglApiChapter {
            Code: "2A".to_string(),
            Name: "EMBLEMS".to_string(),
            IsRepealed: false,
            StrickenText: None,
            Sections: vec![],
        };
        let parsed = parse_chapter_detail(&chapter, "https://example.com/api/Chapters/2A");
        assert_eq!(parsed.chapter_code, "2A");
        assert_eq!(parsed.chapter_name, "EMBLEMS");
    }

    #[test]
    fn test_parse_section_content() {
        let section = MglApiSection {
            Code: "7A".to_string(),
            ChapterCode: Some("1".to_string()),
            Name: Some("Legislative jurisdiction over property".to_string()),
            IsRepealed: false,
            Text: Some(
                "Section 7A. The governor may accept retrocession.\r\n\r\nA copy of the notice shall be filed."
                    .to_string(),
            ),
            Details: None,
        };
        let content = parse_section_content(&section);
        assert_eq!(content.heading, "Legislative jurisdiction over property");
        // The "Section 7A." prefix should be stripped
        assert!(!content.body.starts_with("Section 7A."));
        assert!(content
            .body
            .starts_with("The governor may accept retrocession."));
        assert!(content
            .body
            .contains("A copy of the notice shall be filed."));
    }
}

mod cross_references_tests {
    use ingest::sources::mgl::cross_references::{
        extract_section_cross_references, inline_section_cross_references,
    };

    #[test]
    fn test_extract_chapter_section_references() {
        let refs = extract_section_cross_references(
            "See chapter 268, section 1A and section 7 of chapter 90.",
        );
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].chapter, "268");
        assert_eq!(refs[0].section, "1A");
        assert_eq!(refs[0].link, "/statutes/mgl/chapter/268/section/1a");
        assert_eq!(refs[1].chapter, "90");
        assert_eq!(refs[1].section, "7");
        assert_eq!(refs[1].link, "/statutes/mgl/chapter/90/section/7");
    }

    #[test]
    fn test_inline_section_cross_references() {
        let text = "See chapter 268, section 1A for details.";
        let inlined = inline_section_cross_references(text);
        assert!(inlined.contains("[chapter 268, section 1A]"));
        assert!(inlined.contains("/statutes/mgl/chapter/268/section/1a"));
    }

    #[test]
    fn test_section_with_cross_references() {
        let text = "Section 7A. The governor may accept retrocession. See chapter 268, section 1A for related provisions.";
        let refs = extract_section_cross_references(text);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].chapter, "268");
        assert_eq!(refs[0].section, "1A");
    }
}

mod discover_tests {
    use ingest::sources::mgl::discover::extract_version_id_from_landing_html;

    #[test]
    fn test_extract_version_from_amendment_date() {
        let html = "This site includes all amendments to the General Laws passed before <strong>January 10</strong><strong>, 2025</strong>, for laws enacted since that time";
        let version = extract_version_id_from_landing_html(html);
        assert_eq!(version, "2025-01-10");
    }

    #[test]
    fn test_extract_version_from_copyright() {
        let html = "Copyright &copy; 2024 Commonwealth of Massachusetts";
        let version = extract_version_id_from_landing_html(html);
        assert_eq!(version, "2024-01-01");
    }
}
