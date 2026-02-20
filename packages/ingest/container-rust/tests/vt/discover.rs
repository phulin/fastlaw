use crate::common::{load_fixture, MockFetcher};
use ingest::sources::vt::discover::discover_vt_root;
use ingest::sources::vt::parser::extract_version_id_from_landing_html;

#[tokio::test]
async fn discovers_vt_root_and_title_units() {
    let mut fetcher = MockFetcher::new();
    let landing_html = load_fixture("vt/statutes.html");
    fetcher.add_fixture("https://legislature.vermont.gov/statutes/", &landing_html);

    let result = discover_vt_root(&fetcher, Some("https://legislature.vermont.gov/statutes/"))
        .await
        .expect("VT discovery should succeed");

    assert_eq!(result.version_id, "2025");
    assert_eq!(result.root_node.id, "vt/2025/root");
    assert_eq!(result.unit_roots.len(), 3);
    assert_eq!(result.unit_roots[0].title_num, "02");
    assert_eq!(
        result.unit_roots[0].url,
        "https://legislature.vermont.gov/statutes/title/02"
    );
}

#[test]
fn extracts_vt_version_year_from_landing_text() {
    let landing_html = load_fixture("vt/statutes.html");
    let version = extract_version_id_from_landing_html(&landing_html);
    assert_eq!(version, Some("2025".to_string()));
}

#[tokio::test]
async fn uses_deterministic_fallback_version_when_year_marker_missing() {
    let mut fetcher = MockFetcher::new();
    fetcher.add_fixture(
        "https://legislature.vermont.gov/statutes/",
        r#"<html><body><a href="/statutes/title/02">Title 02 : Legislature</a></body></html>"#,
    );

    let first = discover_vt_root(&fetcher, Some("https://legislature.vermont.gov/statutes/"))
        .await
        .expect("discovery should succeed");
    let second = discover_vt_root(&fetcher, Some("https://legislature.vermont.gov/statutes/"))
        .await
        .expect("discovery should succeed");

    assert_eq!(first.version_id, second.version_id);
    assert!(first.version_id.starts_with("undated-"));
}
