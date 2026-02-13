use ingest::sources::cgs::discover::{extract_title_urls, extract_version_id};
use std::fs;
use std::path::Path;

fn load_titles_fixture() -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/cgs_mirror/current/pub/titles.htm"),
    )
    .expect("titles.htm fixture should exist")
}

#[test]
fn extracts_version_from_titles_html() {
    let html = load_titles_fixture();
    assert_eq!(extract_version_id(&html), "2025");
}

#[test]
fn extracts_unique_absolute_title_urls() {
    let html = load_titles_fixture();
    let title_urls = extract_title_urls(&html, "https://www.cgs.ct.gov/current/pub/titles.htm")
        .expect("extract_title_urls should succeed");

    assert!(!title_urls.is_empty());
    assert_eq!(
        title_urls[0],
        "https://www.cgs.ct.gov/current/pub/title_01.htm"
    );
    assert!(title_urls
        .iter()
        .all(|url| url.starts_with("https://www.cgs.ct.gov/current/pub/title_")));
    assert_eq!(
        title_urls.len(),
        title_urls
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>()
            .len()
    );
}
