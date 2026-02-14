use crate::common::{load_fixture, AdapterTestContext};
use ingest::runtime::types::QueueItem;
use ingest::sources::usc::adapter::UscAdapter;
use ingest::types::SectionContent;

#[tokio::test]
async fn test_adapter_extracts_levels_and_sections() {
    let mut t = AdapterTestContext::new(UscAdapter, "root");

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

    let item = QueueItem {
        url: "http://example.com".to_string(),
        parent_id: "root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "1" }),
    };

    t.add_fixture(&item.url, xml);
    t.run_item(item).await;

    t.expect_node("root/t1/root")
        .level("title")
        .name("General Provisions");

    t.expect_node("root/t1/ch1")
        .level("chapter")
        .parent("root/t1/root");

    t.expect_node("root/t1/ch1/section-1")
        .level("section")
        .parent("root/t1/ch1")
        .name("Words denoting number, gender, etc.")
        .content_contains("In determining the meaning");
}

#[tokio::test]
async fn test_adapter_matches_42_usc_302_nodepayload() {
    let mut t = AdapterTestContext::new(UscAdapter, "root");

    let xml = load_fixture("usc/usc42_s302.xml");
    let item = QueueItem {
        url: "http://example.com".to_string(),
        parent_id: "root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "42" }),
    };

    t.add_fixture(&item.url, &xml);
    t.run_item(item).await;

    let section = t
        .expect_node("root/t42/ch7/schI/section-302")
        .level("section")
        .parent("root/t42/ch7/schI")
        .path("/statutes/usc/section/42/302")
        .readable_id("42 USC 302")
        .heading_citation("42 USC 302")
        .name("State old-age plans");

    let content = section
        .node
        .content
        .clone()
        .expect("section content should exist");
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
    let expected_body = load_fixture("usc/usc42_s302.body.md");
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

#[tokio::test]
async fn test_adapter_handles_source_with_no_children() {
    let mut t = AdapterTestContext::new(UscAdapter, "root");

    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t46">
            <meta><title>Title 46</title></meta>
            <main>
                <title identifier="/us/usc/t46">
                    <num value="46">Title 46</num>
                    <heading>Shipping</heading>
                </title>
            </main>
        </uscDoc>"#;

    let item = QueueItem {
        url: "http://example.com".to_string(),
        parent_id: "root".to_string(),
        level_name: "title".to_string(),
        level_index: 0,
        metadata: serde_json::json!({ "title_num": "46" }),
    };

    t.add_fixture(&item.url, xml);
    t.run_item(item).await;

    // Should at least have the title node
    t.expect_node("root/t46/root")
        .level("title")
        .name("Shipping");
}
