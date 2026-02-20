use crate::common::{load_fixture, MockFetcher};
use ingest::sources::rigl::discover::discover_rigl_root;
use ingest::sources::rigl::parser::extract_version_id_from_landing_html;

#[tokio::test]
async fn discovers_rigl_root_and_title_units() {
    let mut fetcher = MockFetcher::new();
    let landing_html = load_fixture("rigl/statutes.html");
    fetcher.add_fixture(
        "https://webserver.rilegislature.gov/statutes/Statutes.html",
        &landing_html,
    );

    let result = discover_rigl_root(
        &fetcher,
        Some("https://webserver.rilegislature.gov/statutes/Statutes.html"),
    )
    .await
    .expect("RIGL discovery should succeed");

    assert_eq!(result.version_id, "2026");
    assert_eq!(result.root_node.id, "rigl/2026/root");
    assert!(result.unit_roots.len() > 40);
    assert_eq!(result.unit_roots[0].title_num, "1");
    assert_eq!(
        result.unit_roots[0].url,
        "https://webserver.rilegislature.gov/Statutes/TITLE1/INDEX.HTM"
    );
}

#[test]
fn extracts_rigl_version_year_from_landing_text() {
    let landing_html = load_fixture("rigl/statutes.html");
    let version = extract_version_id_from_landing_html(&landing_html);
    assert_eq!(version, Some("2026".to_string()));
}
