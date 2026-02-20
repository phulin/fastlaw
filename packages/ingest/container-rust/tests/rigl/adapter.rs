use crate::common::{
    create_test_context, load_fixture, AdapterTestContext, MockCache, MockNodeStore, MockUrlQueue,
};
use ingest::runtime::types::QueueItem;
use ingest::sources::rigl::adapter::RiglAdapter;
use ingest::sources::SourceAdapter;
use ingest::types::SectionContent;

#[tokio::test]
async fn adapter_emits_title_chapter_and_section_nodes() {
    let mut t = AdapterTestContext::new(RiglAdapter, "rigl/v1/root");

    let title_url = "https://webserver.rilegislature.gov/Statutes/TITLE1/INDEX.HTM";
    let chapter_url = "https://webserver.rilegislature.gov/Statutes/TITLE1/1-2/INDEX.htm";
    let section_url = "https://webserver.rilegislature.gov/Statutes/TITLE1/1-2/1-2-1.htm";

    t.add_fixture(title_url, &load_fixture("rigl/title_1_index_minimal.htm"));
    t.add_fixture(
        chapter_url,
        &load_fixture("rigl/chapter_1-2_index_minimal.htm"),
    );
    t.add_fixture(section_url, &load_fixture("rigl/section_1-2-1.htm"));
    t.add_fixture(
        "https://webserver.rilegislature.gov/Statutes/TITLE1/1-2/1-2-5.htm",
        &load_fixture("rigl/section_1-2-5.htm"),
    );

    let item = QueueItem {
        url: title_url.to_string(),
        parent_id: "rigl/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "title_num": "1",
            "sort_order": 0
        }),
    };

    t.run_item(item).await;

    t.expect_node("rigl/v1/root/title-1")
        .level("title")
        .name("Aeronautics")
        .path("/title/1")
        .readable_id("1")
        .heading_citation("Title 1");

    t.expect_node("rigl/v1/root/title-1/chapter-1-2")
        .level("chapter")
        .name("Airports and Landing Fields")
        .path("/title/1/chapter/1-2")
        .readable_id("1-2");

    t.expect_node("rigl/v1/root/title-1/chapter-1-2/section-1-2-1")
        .level("section")
        .path("/title/1/chapter/1-2/section/1-2-1")
        .readable_id("1-2-1")
        .heading_citation("R.I. Gen. Laws § 1-2-1")
        .content_contains("P.L. 1935, ch. 2250")
        .content_contains("(a) The president and CEO has supervision");
}

#[tokio::test]
async fn adapter_handles_reserved_chapters_without_sections() {
    let mut t = AdapterTestContext::new(RiglAdapter, "rigl/v1/root");

    let title_url = "https://webserver.rilegislature.gov/Statutes/TITLE40.1/INDEX.HTM";
    let chapter_url = "https://webserver.rilegislature.gov/Statutes/TITLE40.1/40.1-8.1/INDEX.htm";
    t.add_fixture(
        title_url,
        &load_fixture("rigl/title_40.1_index_minimal.htm"),
    );
    t.add_fixture(
        chapter_url,
        &load_fixture("rigl/chapter_40.1-8.1_index.htm"),
    );

    let item = QueueItem {
        url: title_url.to_string(),
        parent_id: "rigl/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "title_num": "40.1",
            "sort_order": 0
        }),
    };

    t.run_item(item).await;

    t.expect_node("rigl/v1/root/title-40.1/chapter-40.1-8.1")
        .level("chapter")
        .parent("rigl/v1/root/title-40.1")
        .readable_id("40.1-8.1");

    assert_eq!(
        t.get_nodes()
            .iter()
            .filter(|node| node
                .meta
                .id
                .starts_with("rigl/v1/root/title-40.1/chapter-40.1-8.1/section-"))
            .count(),
        0
    );
}

#[tokio::test]
async fn adapter_inlines_cross_references_and_history_note() {
    let mut t = AdapterTestContext::new(RiglAdapter, "rigl/v1/root");

    let chapter_id = "rigl/v1/root/title-42/chapter-42-11";
    let section_item = QueueItem {
        url: "https://webserver.rilegislature.gov/Statutes/TITLE42/42-11/42-11-2.htm".to_string(),
        parent_id: chapter_id.to_string(),
        level_name: "section".to_string(),
        level_index: 2,
        metadata: serde_json::json!({
            "title_num": "42",
            "chapter_num": "42-11",
            "section_num": "42-11-2",
            "sort_order": 0
        }),
    };

    t.add_fixture(&section_item.url, &load_fixture("rigl/section_42-11-2.htm"));
    t.run_item(section_item).await;

    let node = t.expect_node("rigl/v1/root/title-42/chapter-42-11/section-42-11-2");
    let content = node
        .node
        .content
        .clone()
        .expect("section content should exist");
    let section_content = serde_json::from_value::<SectionContent>(content)
        .expect("section content should deserialize");

    assert!(section_content
        .blocks
        .iter()
        .any(|block| block.type_ == "note" && block.label.as_deref() == Some("History")));
    assert!(section_content
        .blocks
        .iter()
        .filter_map(|block| block.content.as_deref())
        .any(|text| text.contains("[36-3-3](/statutes/section/36-3-3)")));
}

#[tokio::test]
async fn adapter_propagates_unit_id_when_enqueuing_nested_rigl_items() {
    let adapter = RiglAdapter;
    let node_store = MockNodeStore::new();
    let cache = MockCache::new();
    let queue = MockUrlQueue::new();

    let title_url = "https://webserver.rilegislature.gov/Statutes/TITLE1/INDEX.HTM";
    let chapter_url = "https://webserver.rilegislature.gov/Statutes/TITLE1/1-2/INDEX.htm";
    cache.add_fixture(title_url, &load_fixture("rigl/title_1_index_minimal.htm"));
    cache.add_fixture(
        chapter_url,
        &load_fixture("rigl/chapter_1-2_index_minimal.htm"),
    );

    let mut context = create_test_context(
        node_store,
        MockCache {
            fixtures: cache.fixtures.clone(),
        },
        MockUrlQueue {
            enqueued: queue.enqueued.clone(),
        },
        "v1",
        "rigl/v1/root",
    );

    let title_item = QueueItem {
        url: title_url.to_string(),
        parent_id: "rigl/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "rigl-title-1",
            "title_num": "1",
            "sort_order": 0
        }),
    };
    adapter
        .process_url(&mut context, &title_item)
        .await
        .expect("title processing should succeed");

    let chapter_item = queue
        .enqueued
        .lock()
        .unwrap()
        .pop_front()
        .expect("chapter should be queued from title");
    assert_eq!(
        chapter_item.metadata["unit_id"].as_str(),
        Some("rigl-title-1")
    );

    adapter
        .process_url(&mut context, &chapter_item)
        .await
        .expect("chapter processing should succeed");

    let section_item = queue
        .enqueued
        .lock()
        .unwrap()
        .pop_front()
        .expect("section should be queued from chapter");
    assert_eq!(
        section_item.metadata["unit_id"].as_str(),
        Some("rigl-title-1")
    );
}
