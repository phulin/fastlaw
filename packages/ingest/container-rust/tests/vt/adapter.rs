use crate::common::{load_fixture, AdapterTestContext};
use ingest::runtime::types::QueueItem;
use ingest::sources::vt::adapter::VtAdapter;
use ingest::sources::SourceAdapter;
use ingest::types::SectionContent;

#[tokio::test]
async fn adapter_emits_title_chapter_and_section_nodes_from_fullchapter() {
    let mut t = AdapterTestContext::new(VtAdapter, "vt/v1/root");

    let title_url = "https://legislature.vermont.gov/statutes/title/02";
    let fullchapter_url_1 = "https://legislature.vermont.gov/statutes/fullchapter/02/001";
    let fullchapter_url_2 = "https://legislature.vermont.gov/statutes/fullchapter/02/002";

    t.add_fixture(title_url, &load_fixture("vt/title_02.html"));
    t.add_fixture(
        fullchapter_url_1,
        &load_fixture("vt/fullchapter_02_001.html"),
    );
    t.add_fixture(
        fullchapter_url_2,
        &load_fixture("vt/fullchapter_02_002.html"),
    );

    let item = QueueItem {
        url: title_url.to_string(),
        parent_id: "vt/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "vt-title-02",
            "title_num": "02",
            "sort_order": 0
        }),
    };

    t.run_item(item).await;

    t.expect_node("vt/v1/root/title-02")
        .level("title")
        .name("Legislature")
        .path("/title/02")
        .readable_id("02")
        .heading_citation("Title 2");

    t.expect_node("vt/v1/root/title-02/chapter-001")
        .level("chapter")
        .name("General Assembly")
        .path("/title/02/chapter/001")
        .readable_id("1")
        .heading_citation("Chapter 1");

    t.expect_node("vt/v1/root/title-02/chapter-002")
        .level("chapter")
        .name("Joint Legislative Management Committee")
        .path("/title/02/chapter/002")
        .readable_id("2")
        .heading_citation("Chapter 2");

    let section_1 = t.expect_node("vt/v1/root/title-02/chapter-001/section-1");
    section_1
        .level("section")
        .path("/title/02/chapter/001/section/1")
        .readable_id("1")
        .heading_citation("Vt. Stat. tit. 2 § 1")
        .content_contains("[2](/statutes/section/02/001/2)")
        .content_contains("held in Montpelier");

    let section_2 = t.expect_node("vt/v1/root/title-02/chapter-001/section-2");
    section_2.level("section").content_contains("History");

    t.expect_node("vt/v1/root/title-02/chapter-001/section-5")
        .level("section")
        .content_contains("Repealed");

    t.expect_node("vt/v1/root/title-02/chapter-002/section-41")
        .level("section")
        .path("/title/02/chapter/002/section/41")
        .readable_id("41")
        .content_contains("Joint Legislative Management Committee");

    assert!(t
        .get_nodes()
        .iter()
        .filter(|node| node.meta.level_name == "section")
        .all(|node| {
            let content = node
                .content
                .as_ref()
                .expect("section nodes should include content");
            let section_content = serde_json::from_value::<SectionContent>(content.clone())
                .expect("section content should deserialize");
            section_content
                .blocks
                .iter()
                .find(|block| block.type_ == "body")
                .and_then(|block| block.content.as_ref())
                .is_some_and(|body| !body.trim().is_empty())
        }));
}

#[tokio::test]
async fn adapter_fetches_fullchapter_without_section_page_fixtures() {
    let adapter = VtAdapter;
    let node_store = crate::common::MockNodeStore::new();
    let cache = crate::common::MockCache::new();
    let queue = crate::common::MockUrlQueue::new();

    let title_url = "https://legislature.vermont.gov/statutes/title/02";
    cache.add_fixture(title_url, &load_fixture("vt/title_02.html"));
    cache.add_fixture(
        "https://legislature.vermont.gov/statutes/fullchapter/02/001",
        &load_fixture("vt/fullchapter_02_001.html"),
    );
    cache.add_fixture(
        "https://legislature.vermont.gov/statutes/fullchapter/02/002",
        &load_fixture("vt/fullchapter_02_002.html"),
    );

    let mut context = crate::common::create_test_context(
        node_store.clone(),
        crate::common::MockCache {
            fixtures: cache.fixtures.clone(),
        },
        crate::common::MockUrlQueue {
            enqueued: queue.enqueued.clone(),
        },
        "v1",
        "vt/v1/root",
    );

    let title_item = QueueItem {
        url: title_url.to_string(),
        parent_id: "vt/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "vt-title-02",
            "title_num": "02",
            "sort_order": 0
        }),
    };

    adapter
        .process_url(&mut context, &title_item)
        .await
        .expect("title processing should succeed");

    while let Some(item) = queue.enqueued.lock().unwrap().pop_front() {
        adapter
            .process_url(&mut context, &item)
            .await
            .expect("chapter processing should succeed");
    }

    let section_count = node_store
        .nodes
        .lock()
        .unwrap()
        .iter()
        .filter(|node| node.meta.level_name == "section")
        .count();
    assert!(section_count >= 4);
}
