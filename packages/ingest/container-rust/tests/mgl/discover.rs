use crate::common::MockFetcher;
use ingest::sources::mgl::discover::{discover_mgl_root, extract_version_id_from_landing_html};

#[tokio::test]
async fn test_discover_mgl_root_with_mock_fetcher() {
    let mut fetcher = MockFetcher::new();

    // Mock landing page
    fetcher.add_fixture(
        "https://malegislature.gov/Laws/GeneralLaws",
        "This site includes all amendments to the General Laws passed before <strong>January 10</strong><strong>, 2025</strong>"
    );

    // Mock Parts API
    fetcher.add_fixture(
        "https://malegislature.gov/api/Parts",
        r#"[{"Code":"I","Details":"ADMINISTRATION OF THE GOVERNMENT"}]"#,
    );

    // Mock Part I Detail API
    fetcher.add_fixture(
        "https://malegislature.gov/api/Parts/I",
        r#"{"Code":"I","Name":"ADMINISTRATION OF THE GOVERNMENT","FirstChapter":1,"LastChapter":2,"Chapters":[]}"#
    );

    let result = discover_mgl_root(&fetcher, "https://malegislature.gov/api/Parts")
        .await
        .expect("Discovery failed");

    assert_eq!(result.version_id, "2025-01-10");
    assert_eq!(result.unit_roots.len(), 1);
    assert_eq!(result.unit_roots[0].title_num, "I");
}

#[test]
fn test_extract_version_from_amendment_date() {
    let html = "This site includes all amendments to the General Laws passed before <strong>January 10</strong><strong>, 2025</strong>, for laws enacted since that time";
    let version = extract_version_id_from_landing_html(html);
    assert_eq!(version, "2025-01-10");
}

#[test]
fn test_extract_version_from_copyright() {
    let html = "Copyright &copy; 2024 Commonwealth of Massachusetts";
    let version = extract_version_id_from_landing_html(html);
    assert_eq!(version, "2024-01-01");
}
