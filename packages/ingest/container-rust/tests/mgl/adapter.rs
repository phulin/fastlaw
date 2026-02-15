use crate::common::{load_fixture, AdapterTestContext};
use crate::mgl::{prune_chapter_json, prune_part_json};
use ingest::runtime::types::QueueItem;
use ingest::sources::mgl::adapter::MglAdapter;
use ingest::types::SectionContent;

#[tokio::test]
async fn test_adapter_extracts_part_chapter_and_sections() {
    let mut t = AdapterTestContext::new(MglAdapter, "mgl/v1/root");

    let part_json_raw = load_fixture("mgl/mgl_part_i.json");
    let part_json = prune_part_json(&part_json_raw, "1");

    let chapter_json_raw = load_fixture("mgl/mgl_chapter_1.json");
    let chapter_json = prune_chapter_json(&chapter_json_raw, &["1", "7A"]);

    let section_1_json = load_fixture("mgl/mgl_section_1.json");
    let section_7a_json = load_fixture("mgl/mgl_section_7a.json");

    t.add_fixture("https://malegislature.gov/api/Chapters/1", &chapter_json);
    t.add_fixture(
        "https://malegislature.gov/api/Chapters/1/Sections/1/",
        &section_1_json,
    );
    t.add_fixture(
        "https://malegislature.gov/api/Chapters/1/Sections/7A/",
        &section_7a_json,
    );

    let item = QueueItem {
        url: "https://malegislature.gov/api/Parts/I".to_string(),
        parent_id: "mgl/v1/root".to_string(),
        level_name: "part".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "I" }),
    };

    t.add_fixture(&item.url, &part_json);
    t.run_item(item).await;

    t.expect_node("mgl/v1/root/part-i")
        .level("part")
        .readable_id("I");

    t.expect_node("mgl/v1/root/part-i/chapter-1")
        .level("chapter")
        .parent("mgl/v1/root/part-i");

    assert_eq!(
        t.get_nodes()
            .iter()
            .filter(|n| n.meta.level_name == "section")
            .count(),
        2
    );

    t.expect_node("mgl/v1/root/part-i/chapter-1/section-7a")
        .level("section")
        .parent("mgl/v1/root/part-i/chapter-1")
        .readable_id("7A")
        .heading_citation("MGL c.1 §7A");
}

#[tokio::test]
async fn test_adapter_mock_integration() {
    let mut t = AdapterTestContext::new(MglAdapter, "mgl/v1/root");

    // Load real fixtures but replace the domain to simulate a mocked environment
    let part_json_raw =
        load_fixture("mgl/mgl_part_i.json").replace("http://malegislature.gov", "https://fake.gov");
    let part_json = prune_part_json(&part_json_raw, "1");

    let chapter_json_raw = load_fixture("mgl/mgl_chapter_1.json")
        .replace("http://malegislature.gov", "https://fake.gov");
    let chapter_json = prune_chapter_json(&chapter_json_raw, &["1"]);

    let section_json = load_fixture("mgl/mgl_section_1.json")
        .replace("http://malegislature.gov", "https://fake.gov");

    t.add_fixture("https://fake.gov/api/Chapters/1", &chapter_json);
    t.add_fixture("https://fake.gov/api/Chapters/1/Sections/1/", &section_json);

    let item = QueueItem {
        url: "https://fake.gov/api/Parts/I".to_string(),
        parent_id: "mgl/v1/root".to_string(),
        level_name: "part".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "I" }),
    };

    t.add_fixture(&item.url, &part_json);
    t.run_item(item).await;

    assert_eq!(t.get_nodes().len(), 3); // Part, Chapter, Section

    t.expect_node("mgl/v1/root/part-i/chapter-1/section-1")
        .level("section")
        .readable_id("1")
        .path("/part/i/chapter/1/section/1")
        .heading_citation("MGL c.1 §1")
        .name("Citizens of commonwealth defined")
        .content_contains("All persons who are citizens of the United States");
}

#[tokio::test]
async fn test_adapter_mock_integration_multiple_sections() {
    let mut t = AdapterTestContext::new(MglAdapter, "mgl/v1/root");

    let part_json_raw = load_fixture("mgl/mgl_part_i.json")
        .replace("http://malegislature.gov", "https://fake.gov")
        .replace("https://malegislature.gov", "https://fake.gov");
    let part_json = prune_part_json(&part_json_raw, "1");

    let chapter_json_raw = load_fixture("mgl/mgl_chapter_1.json")
        .replace("http://malegislature.gov", "https://fake.gov")
        .replace("https://malegislature.gov", "https://fake.gov");
    let chapter_json = prune_chapter_json(&chapter_json_raw, &["1", "2"]);

    let section_1_json = load_fixture("mgl/mgl_section_1.json")
        .replace("http://malegislature.gov", "https://fake.gov")
        .replace("https://malegislature.gov", "https://fake.gov");

    let section_2_json = load_fixture("mgl/mgl_section_2.json")
        .replace("http://malegislature.gov", "https://fake.gov")
        .replace("https://malegislature.gov", "https://fake.gov");

    t.add_fixture("https://fake.gov/api/Chapters/1", &chapter_json);
    t.add_fixture(
        "https://fake.gov/api/Chapters/1/Sections/1/",
        &section_1_json,
    );
    t.add_fixture(
        "https://fake.gov/api/Chapters/1/Sections/2/",
        &section_2_json,
    );

    let item = QueueItem {
        url: "https://fake.gov/api/Parts/I".to_string(),
        parent_id: "mgl/v1/root".to_string(),
        level_name: "part".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "I" }),
    };

    t.add_fixture(&item.url, &part_json);
    t.run_item(item).await;

    assert_eq!(t.get_nodes().len(), 4);

    t.expect_node("mgl/v1/root/part-i")
        .level("part")
        .parent("mgl/v1/root")
        .name("ADMINISTRATION OF THE GOVERNMENT")
        .path("/part/i")
        .readable_id("I")
        .heading_citation("Part I");

    t.expect_node("mgl/v1/root/part-i/chapter-1")
        .level("chapter")
        .parent("mgl/v1/root/part-i")
        .name("JURISDICTION OF THE COMMONWEALTH AND OF THE UNITED STATES")
        .path("/part/i/chapter/1")
        .readable_id("1")
        .heading_citation("Chapter 1");

    t.expect_node("mgl/v1/root/part-i/chapter-1/section-1")
        .level("section")
        .parent("mgl/v1/root/part-i/chapter-1")
        .readable_id("1")
        .name("Citizens of commonwealth defined")
        .path("/part/i/chapter/1/section/1")
        .heading_citation("MGL c.1 §1")
        .content_contains("citizens of the United States");

    t.expect_node("mgl/v1/root/part-i/chapter-1/section-2")
        .level("section")
        .parent("mgl/v1/root/part-i/chapter-1")
        .readable_id("2")
        .name("Sovereignty and jurisdiction of commonwealth")
        .path("/part/i/chapter/1/section/2")
        .heading_citation("MGL c.1 §2")
        .content_contains("The sovereignty and jurisdiction of the commonwealth");
}

#[tokio::test]
async fn test_adapter_section_body_matches_expected_markdown() {
    let mut t = AdapterTestContext::new(MglAdapter, "mgl/v1/root");

    let part_json_raw = load_fixture("mgl/mgl_part_i.json");
    let part_json = prune_part_json(&part_json_raw, "1");

    let chapter_json_raw = load_fixture("mgl/mgl_chapter_1.json");
    let chapter_json = prune_chapter_json(&chapter_json_raw, &["7A"]);

    let section_7a_json = load_fixture("mgl/mgl_section_7a.json");

    t.add_fixture("https://malegislature.gov/api/Chapters/1", &chapter_json);
    t.add_fixture(
        "https://malegislature.gov/api/Chapters/1/Sections/7A/",
        &section_7a_json,
    );

    let item = QueueItem {
        url: "https://malegislature.gov/api/Parts/I".to_string(),
        parent_id: "mgl/v1/root".to_string(),
        level_name: "part".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "I" }),
    };

    t.add_fixture(&item.url, &part_json);
    t.run_item(item).await;

    let section_7a = t.expect_node("mgl/v1/root/part-i/chapter-1/section-7a");

    let content = section_7a
        .node
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

    let expected_body = load_fixture("mgl/mgl_chapter_1_section_7a.body.md");
    let normalized_body = body.replace("\r\n", "\n").trim().to_string();
    let normalized_expected = expected_body.replace("\r\n", "\n").trim().to_string();

    assert_eq!(normalized_body, normalized_expected);
}

#[tokio::test]
async fn test_adapter_fetches_individual_section_when_text_missing() {
    let mut t = AdapterTestContext::new(MglAdapter, "mgl/v1/root");

    let part_json_raw = load_fixture("mgl/mgl_part_i.json");
    let part_json = prune_part_json(&part_json_raw, "1");

    let chapter_json_raw = load_fixture("mgl/mgl_chapter_1.json");
    let chapter_json = prune_chapter_json(&chapter_json_raw, &["1"]);

    let section_1_json = load_fixture("mgl/mgl_section_1.json");

    t.add_fixture("https://malegislature.gov/api/Chapters/1", &chapter_json);
    t.add_fixture(
        "https://malegislature.gov/api/Chapters/1/Sections/1/",
        &section_1_json,
    );

    let item = QueueItem {
        url: "https://malegislature.gov/api/Parts/I".to_string(),
        parent_id: "mgl/v1/root".to_string(),
        level_name: "part".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "I" }),
    };

    t.add_fixture(&item.url, &part_json);
    t.run_item(item).await;

    t.expect_node("mgl/v1/root/part-i/chapter-1/section-1")
        .content_contains("All persons who are citizens of the United States");
}
