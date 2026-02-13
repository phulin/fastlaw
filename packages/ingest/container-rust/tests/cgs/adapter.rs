use crate::common::{self, load_fixture, AdapterTestContext};
use ingest::runtime::types::QueueItem;
use ingest::sources::cgs::adapter::CgsAdapter;
use ingest::types::SectionContent;
use std::fs;
use std::path::Path;

#[tokio::test]
async fn adapter_emits_title_chapter_and_sections() {
    let mut t = AdapterTestContext::new(CgsAdapter, "root");

    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let item = QueueItem {
        url: "https://www.cgs.ct.gov/current/pub/chap_377a.htm".to_string(),
        parent_id: "root/title-20".to_string(),
        level_name: "chapter".to_string(),
        level_index: 1,
        metadata: serde_json::json!({
            "title_num": "20",
            "chapter_id": "377a",
            "unit_id": "test"
        }),
    };

    t.add_fixture(&item.url, &html);
    t.run_item(item).await;

    t.expect_node("root/title-20/chapter-377a")
        .level("chapter")
        .parent("root/title-20");

    assert_eq!(
        t.get_nodes()
            .iter()
            .filter(|node| node.meta.level_name == "section")
            .count(),
        2
    );

    let first = t
        .expect_node("root/title-20/chapter-377a/section-20-86aa")
        .path("/statutes/cgs/section/20-86aa")
        .parent("root/title-20/chapter-377a");

    let content = first
        .node
        .content
        .clone()
        .expect("section content should exist");
    let section_content = serde_json::from_value::<SectionContent>(content)
        .expect("section content should deserialize");
    assert!(section_content.metadata.is_none());
    assert_eq!(section_content.blocks[0].type_, "body");

    let expected_body = load_fixture("cgs/cgs_20-86aa.body.md");
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
    let mut t = AdapterTestContext::new(CgsAdapter, "root");

    let html = fs::read_to_string(
        Path::new(&common::fixtures_dir())
            .join("../../../../../data/cgs_mirror/current/pub/chap_001.htm"),
    )
    .expect("chapter 001 mirror should exist");

    let item = QueueItem {
        url: "https://www.cgs.ct.gov/current/pub/chap_001.htm".to_string(),
        parent_id: "root/title-1".to_string(),
        level_name: "chapter".to_string(),
        level_index: 1,
        metadata: serde_json::json!({
            "title_num": "1",
            "chapter_id": "001",
            "unit_id": "test"
        }),
    };

    t.add_fixture(&item.url, &html);
    t.run_item(item).await;

    t.expect_node("root/title-1/chapter-001/section-1-1a")
        .path("/statutes/cgs/section/1-1a")
        .content_contains("[42a-1-201](/statutes/cgs/section/42a-1-201)")
        .content_contains("[42a-9-109](/statutes/cgs/section/42a-9-109)");
}

#[tokio::test]
async fn adapter_handles_article_units() {
    let mut t = AdapterTestContext::new(CgsAdapter, "root");

    let html = load_fixture("cgs/cgs_art_001.htm");
    let item = QueueItem {
        url: "https://www.cgs.ct.gov/current/pub/art_001.htm".to_string(),
        parent_id: "root/title-42a".to_string(),
        level_name: "article".to_string(),
        level_index: 1,
        metadata: serde_json::json!({
            "title_num": "42a",
            "chapter_id": "1",
            "unit_id": "test"
        }),
    };

    t.add_fixture(&item.url, &html);
    t.run_item(item).await;

    t.expect_node("root/title-42a/article-1").level("article");

    t.expect_node("root/title-42a/article-1/section-42a-1-101")
        .path("/statutes/cgs/section/42a-1-101")
        .parent("root/title-42a/article-1");
}
