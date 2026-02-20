use crate::common::{
    create_test_context, load_fixture, AdapterTestContext, MockCache, MockNodeStore, MockUrlQueue,
};
use async_trait::async_trait;
use ingest::runtime::types::QueueItem;
use ingest::runtime::types::{BuildContext, IngestContext, NodeStore, UrlQueue};
use ingest::sources::nh::adapter::NhAdapter;
use ingest::sources::SourceAdapter;
use ingest::types::{NodePayload, SectionContent};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn adapter_emits_title_chapter_and_section_nodes() {
    let mut t = AdapterTestContext::new(NhAdapter, "nh/v1/root");

    let title_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm";
    let chapter_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I-21-J.htm";
    let section_url = "https://gc.nh.gov/rsa/html/I/21-J/21-J-31.htm";

    t.add_fixture(title_url, minimal_title_i_toc_for_21_j());
    t.add_fixture(chapter_url, minimal_chapter_21_j_toc());
    t.add_fixture(section_url, &load_fixture("nh/section_21-j-31.htm"));
    t.add_fixture(
        "https://gc.nh.gov/rsa/html/I/21-J/21-J-6-a.htm",
        &load_fixture("nh/section_21-j-6-a.htm"),
    );

    let item = QueueItem {
        url: title_url.to_string(),
        parent_id: "nh/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "nh-title-i",
            "title_num": "I",
            "sort_order": 0
        }),
    };

    t.run_item(item).await;

    t.expect_node("nh/v1/root/title-i")
        .level("title")
        .name("THE STATE AND ITS GOVERNMENT")
        .path("/title/i")
        .readable_id("I")
        .heading_citation("Title I");

    t.expect_node("nh/v1/root/title-i/chapter-21-j")
        .level("chapter")
        .name("DEPARTMENT OF REVENUE ADMINISTRATION")
        .path("/title/i/chapter/21-j")
        .readable_id("21-J")
        .heading_citation("Chapter 21-J");

    t.expect_node("nh/v1/root/title-i/chapter-21-j/section-21-j-31")
        .level("section")
        .path("/title/i/chapter/21-j/section/21-j-31")
        .readable_id("21-J:31")
        .heading_citation("N.H. Rev. Stat. § 21-J:31")
        .content_contains("Any taxpayer who fails to file a return")
        .content_contains("[77-A:9](/title/i/chapter/77-a/section/77-a-9)");

    t.expect_node("nh/v1/root/title-i/chapter-21-j/section-21-j-6-a")
        .level("section")
        .content_contains("Repealed by 2016");
}

#[tokio::test]
async fn adapter_parses_merged_ucc_chapter_when_section_links_absent() {
    let mut t = AdapterTestContext::new(NhAdapter, "nh/v1/root");

    let title_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-XXXIV-A.htm";
    let chapter_toc_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-XXXIV-A-382-A.htm";
    let merged_url = "https://gc.nh.gov/rsa/html/XXXIV-A/382-A/382-A-mrg.htm";

    t.add_fixture(title_url, &load_fixture("nh/title_xxxiv-a_toc.htm"));
    t.add_fixture(chapter_toc_url, &load_fixture("nh/chapter_382-a_toc.htm"));
    t.add_fixture(merged_url, &load_fixture("nh/chapter_382-a_mrg.htm"));

    let item = QueueItem {
        url: title_url.to_string(),
        parent_id: "nh/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "nh-title-xxxiv-a",
            "title_num": "XXXIV-A",
            "sort_order": 0
        }),
    };
    t.run_item(item).await;

    t.expect_node("nh/v1/root/title-xxxiv-a/chapter-382-a")
        .level("chapter")
        .name("UNIFORM COMMERCIAL CODE")
        .path("/title/xxxiv-a/chapter/382-a");

    t.expect_node("nh/v1/root/title-xxxiv-a/chapter-382-a/section-382-a-1-101")
        .level("section")
        .readable_id("382-A:1-101")
        .content_contains("Uniform Commercial Code")
        .content_contains("Source");
}

#[tokio::test]
async fn adapter_propagates_unit_id_when_queuing_nested_items() {
    let adapter = NhAdapter;
    let node_store = MockNodeStore::new();
    let cache = MockCache::new();
    let queue = MockUrlQueue::new();

    let title_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm";
    let chapter_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I-5-A.htm";
    cache.add_fixture(title_url, minimal_title_i_toc_for_5_a());
    cache.add_fixture(chapter_url, minimal_chapter_5_a_toc());

    let mut context = create_test_context(
        node_store,
        MockCache {
            fixtures: cache.fixtures.clone(),
        },
        MockUrlQueue {
            enqueued: queue.enqueued.clone(),
        },
        "v1",
        "nh/v1/root",
    );

    let title_item = QueueItem {
        url: title_url.to_string(),
        parent_id: "nh/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "nh-title-i",
            "title_num": "I",
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
        .expect("chapter should be queued");
    assert_eq!(
        chapter_item.metadata["unit_id"].as_str(),
        Some("nh-title-i")
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
        .expect("section should be queued");
    assert_eq!(
        section_item.metadata["unit_id"].as_str(),
        Some("nh-title-i")
    );
}

#[derive(Clone)]
struct CountingBatchNodeStore {
    state: Arc<Mutex<CountingBatchState>>,
    batch_size: usize,
}

struct CountingBatchState {
    inserted_nodes: usize,
    pending_nodes: usize,
    callbacks: usize,
}

impl CountingBatchNodeStore {
    fn new(batch_size: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(CountingBatchState {
                inserted_nodes: 0,
                pending_nodes: 0,
                callbacks: 0,
            })),
            batch_size,
        }
    }

    fn counts(&self) -> (usize, usize) {
        let state = self.state.lock().unwrap();
        (state.inserted_nodes, state.callbacks)
    }
}

#[async_trait]
impl NodeStore for CountingBatchNodeStore {
    async fn insert_node(&self, _node: NodePayload) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        state.inserted_nodes += 1;
        state.pending_nodes += 1;
        if state.pending_nodes >= self.batch_size {
            state.callbacks += 1;
            state.pending_nodes = 0;
        }
        Ok(())
    }

    async fn flush(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.pending_nodes > 0 {
            state.callbacks += 1;
            state.pending_nodes = 0;
        }
        Ok(())
    }
}

#[tokio::test]
async fn adapter_supports_aggregated_batch_callbacks() {
    let adapter = NhAdapter;
    let node_store = CountingBatchNodeStore::new(3);
    let cache = MockCache::new();
    let queue = MockUrlQueue::new();

    let title_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm";
    let chapter_url = "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I-5-A.htm";
    cache.add_fixture(title_url, minimal_title_i_toc_for_5_a());
    cache.add_fixture(chapter_url, minimal_chapter_5_a_toc());
    cache.add_fixture(
        "https://gc.nh.gov/rsa/html/I/5-A/5-A-1.htm",
        &load_fixture("nh/section_5-a-1.htm"),
    );
    cache.add_fixture(
        "https://gc.nh.gov/rsa/html/I/5-A/5-A-2.htm",
        &load_fixture("nh/section_5-a-1.htm"),
    );
    cache.add_fixture(
        "https://gc.nh.gov/rsa/html/I/5-A/5-A-3.htm",
        &load_fixture("nh/section_5-a-1.htm"),
    );

    let mut context = IngestContext {
        build: BuildContext {
            source_version_id: "v1",
            root_node_id: "nh/v1/root",
            accessed_at: "2024-01-01",
            unit_sort_order: 0,
        },
        nodes: Box::new(node_store.clone()),
        blobs: Arc::new(crate::common::MockBlobStore),
        cache: Arc::new(MockCache {
            fixtures: cache.fixtures.clone(),
        }),
        queue: Arc::new(MockUrlQueue {
            enqueued: queue.enqueued.clone(),
        }),
        logger: Arc::new(crate::common::MockLogger),
    };

    queue.enqueue(QueueItem {
        url: title_url.to_string(),
        parent_id: "nh/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "nh-title-i",
            "title_num": "I",
            "sort_order": 0
        }),
    });

    loop {
        let item = { queue.enqueued.lock().unwrap().pop_front() };
        let Some(item) = item else {
            break;
        };
        adapter
            .process_url(&mut context, &item)
            .await
            .expect("processing should succeed");
    }
    context.nodes.flush().await.expect("flush should succeed");

    let (inserted_nodes, callbacks) = node_store.counts();
    assert!(inserted_nodes >= 5);
    assert!(callbacks > 1);
    assert!(callbacks < inserted_nodes);
}

#[tokio::test]
async fn section_nodes_include_non_empty_body_blocks() {
    let mut t = AdapterTestContext::new(NhAdapter, "nh/v1/root");
    t.add_fixture(
        "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm",
        minimal_title_i_toc_for_21_j(),
    );
    t.add_fixture(
        "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I-21-J.htm",
        minimal_chapter_21_j_toc(),
    );
    t.add_fixture(
        "https://gc.nh.gov/rsa/html/I/21-J/21-J-31.htm",
        &load_fixture("nh/section_21-j-31.htm"),
    );
    t.add_fixture(
        "https://gc.nh.gov/rsa/html/I/21-J/21-J-6-a.htm",
        &load_fixture("nh/section_21-j-6-a.htm"),
    );

    t.run_item(QueueItem {
        url: "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm".to_string(),
        parent_id: "nh/v1/root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({
            "unit_id": "nh-title-i",
            "title_num": "I",
            "sort_order": 0
        }),
    })
    .await;

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

fn minimal_title_i_toc_for_21_j() -> &'static str {
    r#"
<html>
  <body>
    <center><h2>I: THE STATE AND ITS GOVERNMENT</h2></center>
    <ul>
      <li>
        <a href="NHTOC-I-21-J.htm">CHAPTER 21-J: DEPARTMENT OF REVENUE ADMINISTRATION</a>
      </li>
    </ul>
  </body>
</html>
"#
}

fn minimal_title_i_toc_for_5_a() -> &'static str {
    r#"
<html>
  <body>
    <center><h2>I: THE STATE AND ITS GOVERNMENT</h2></center>
    <ul>
      <li>
        <a href="NHTOC-I-5-A.htm">CHAPTER 5-A: INTERPLEADER COMPACT</a>
      </li>
    </ul>
  </body>
</html>
"#
}

fn minimal_chapter_21_j_toc() -> &'static str {
    r#"
<html>
  <body>
    <center><h2><a href="../I/21-J/21-J-mrg.htm">CHAPTER 21-J: DEPARTMENT OF REVENUE ADMINISTRATION</a></h2></center>
    <ul>
      <li><a href="../I/21-J/21-J-6-a.htm">Section: 21-J:6-a Repealed by 2016, 85:10, II, eff. July 18, 2016.</a></li>
      <li><a href="../I/21-J/21-J-31.htm">Section: 21-J:31 Penalty for Failure to File.</a></li>
    </ul>
  </body>
</html>
"#
}

fn minimal_chapter_5_a_toc() -> &'static str {
    r#"
<html>
  <body>
    <center><h2><a href="../I/5-A/5-A-mrg.htm">CHAPTER 5-A: INTERPLEADER COMPACT</a></h2></center>
    <ul>
      <li><a href="../I/5-A/5-A-1.htm">Section: 5-A:1 Adoption of Compact.</a></li>
      <li><a href="../I/5-A/5-A-2.htm">Section: 5-A:2 Secretary of State.</a></li>
      <li><a href="../I/5-A/5-A-3.htm">Section: 5-A:3 Withdrawal Action.</a></li>
    </ul>
  </body>
</html>
"#
}
