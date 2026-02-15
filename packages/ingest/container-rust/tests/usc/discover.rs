use crate::common::MockFetcher;
use ingest::sources::usc::discover::discover_usc_root;

const USC_DOWNLOAD_PAGE_URL: &str = "https://uscode.house.gov/download/download.shtml";

#[tokio::test]
async fn test_discover_usc_root_relative_href() {
    let mock_html = r#"
        <html>
            <body>
                <a href="releasepoints/us/pl/119/73not60/xml_usc54@119-73not60.zip">
                    xml_usc54@119-73not60.zip
                </a>
            </body>
        </html>
    "#;

    let mut fetcher = MockFetcher::new();
    fetcher.add_fixture(USC_DOWNLOAD_PAGE_URL, mock_html);

    let result = discover_usc_root(&fetcher, USC_DOWNLOAD_PAGE_URL, None)
        .await
        .expect("Discovery failed");

    let unit = result
        .unit_roots
        .iter()
        .find(|u| u.title_num == "54")
        .expect("Title 54 should be found");
    assert_eq!(
        unit.url,
        "https://uscode.house.gov/download/releasepoints/us/pl/119/73not60/xml_usc54@119-73not60.zip"
    );
}
