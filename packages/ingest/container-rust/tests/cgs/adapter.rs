use crate::common::{self, load_fixture, AdapterTestContext};
use ingest::sources::cgs::adapter::CgsAdapter;
use ingest::types::{SectionContent, UnitEntry};
use std::fs;
use std::path::Path;

#[tokio::test]
async fn adapter_emits_title_chapter_and_sections() {
    let mut t = AdapterTestContext::new(CgsAdapter, "root");

    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let unit = UnitEntry {
        unit_id: "test".to_string(),
        url: "https://www.cgs.ct.gov/current/pub/chap_377a.htm".to_string(),
        sort_order: 1,
        payload: serde_json::json!({
            "titleId": "20",
            "titleName": "Professional and Occupational Licensing, Certification",
            "chapterId": "377a",
            "chapterName": "Doulas",
            "unitKind": "chapter",
            "titleSortOrder": 20,
            "chapterSortOrder": 37700001,
        }),
    };

    t.add_fixture(&unit.url, &html);
    t.run_url(&unit).await;

    t.expect_node("root/title-20")
        .level("title")
        .path("/statutes/cgs/title/20");

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

    let unit = UnitEntry {
        unit_id: "test".to_string(),
        url: "https://www.cgs.ct.gov/current/pub/chap_001.htm".to_string(),
        sort_order: 1,
        payload: serde_json::json!({
            "titleId": "1",
            "titleName": "General Provisions",
            "chapterId": "001",
            "chapterName": "Construction of Statutes",
            "unitKind": "chapter",
        }),
    };

    t.add_fixture(&unit.url, &html);
    t.run_url(&unit).await;

    t.expect_node("root/title-1/chapter-001/section-1-1a")
        .path("/statutes/cgs/section/1-1a")
        .content_contains("[42a-1-201](/statutes/cgs/section/42a-1-201)")
        .content_contains("[42a-9-109](/statutes/cgs/section/42a-9-109)");
}

#[tokio::test]
async fn adapter_handles_article_units() {
    let mut t = AdapterTestContext::new(CgsAdapter, "root");

    let html = load_fixture("cgs/cgs_art_001.htm");
    let unit = UnitEntry {
        unit_id: "test".to_string(),
        url: "https://www.cgs.ct.gov/current/pub/art_001.htm".to_string(),
        sort_order: 1,
        payload: serde_json::json!({
            "titleId": "42a",
            "titleName": "Uniform Commercial Code",
            "chapterId": "1",
            "chapterName": "General Provisions",
            "unitKind": "article",
        }),
    };

    t.add_fixture(&unit.url, &html);
    t.run_url(&unit).await;

    t.expect_node("root/title-42a/article-1").level("article");

    t.expect_node("root/title-42a/article-1/section-42a-1-101")
        .path("/statutes/cgs/section/42a-1-101")
        .parent("root/title-42a/article-1");
}
