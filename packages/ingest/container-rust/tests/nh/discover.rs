use crate::common::{load_fixture, MockFetcher};
use ingest::sources::nh::discover::discover_nh_root;
use ingest::sources::nh::parser::extract_version_id_from_landing_html;

#[tokio::test]
async fn discovers_nh_root_and_title_units() {
    let mut fetcher = MockFetcher::new();
    let landing_html = load_fixture("nh/nhtoc.htm");
    fetcher.add_fixture("https://gc.nh.gov/rsa/html/nhtoc.htm", &landing_html);

    let result = discover_nh_root(&fetcher, Some("https://gc.nh.gov/rsa/html/nhtoc.htm"))
        .await
        .expect("NH discovery should succeed");

    assert!(result.version_id.starts_with("undated-"));
    assert_eq!(
        result.root_node.id,
        format!("nh/{}/root", result.version_id)
    );
    assert!(result.unit_roots.len() > 60);
    assert_eq!(result.unit_roots[0].title_num, "I");
    assert_eq!(
        result.unit_roots[0].url,
        "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm"
    );
}

#[test]
fn returns_none_for_version_when_no_current_through_marker_exists() {
    let landing_html = load_fixture("nh/nhtoc.htm");
    let version = extract_version_id_from_landing_html(&landing_html);
    assert_eq!(version, None);
}

#[tokio::test]
async fn uses_deterministic_fallback_version_when_marker_missing() {
    let mut fetcher = MockFetcher::new();
    fetcher.add_fixture(
        "https://gc.nh.gov/rsa/html/nhtoc.htm",
        r#"<html><body><a href="NHTOC/NHTOC-I.htm">TITLE I: THE STATE</a></body></html>"#,
    );

    let first = discover_nh_root(&fetcher, Some("https://gc.nh.gov/rsa/html/nhtoc.htm"))
        .await
        .expect("discovery should succeed");
    let second = discover_nh_root(&fetcher, Some("https://gc.nh.gov/rsa/html/nhtoc.htm"))
        .await
        .expect("discovery should succeed");

    assert_eq!(first.version_id, second.version_id);
    assert!(first.version_id.starts_with("undated-"));
}
