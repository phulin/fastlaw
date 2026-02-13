use crate::sources::cga::parser::{designator_sort_order, normalize_designator};
use crate::types::{DiscoveryResult, NodeMeta, UscUnitRoot};
use regex::Regex;
use std::sync::LazyLock;

const CGA_TITLES_PAGE_URL: &str = "https://www.cga.ct.gov/current/pub/titles.htm";
const SOURCE_CODE: &str = "cgs";
const SOURCE_NAME: &str = "Connecticut General Statutes";

static TITLE_HREF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)href\s*=\s*["']([^"']*title_[^"']+\.htm)["']"#).unwrap());
static TITLE_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)title_([^.]+)\.htm").unwrap());
static VERSION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"(?i)revised\s+to\s+\w+\s+\d+,?\s+(\d{4})").unwrap(),
        Regex::new(r"(?i)current\s+through\s+.*?(\d{4})").unwrap(),
        Regex::new(r"(?i)as\s+of\s+.*?(\d{4})").unwrap(),
    ]
});

pub async fn discover_cga_root(
    fetcher: &dyn crate::runtime::fetcher::Fetcher,
    start_url: &str,
) -> Result<DiscoveryResult, String> {
    let html = fetcher.fetch(start_url).await?;
    let version_id = extract_version_id(&html);
    let title_urls = extract_title_urls(&html, start_url)?;

    if title_urls.is_empty() {
        return Err("Found no CGA title pages on titles index.".to_string());
    }

    let mut titles = Vec::with_capacity(title_urls.len());
    for title_url in title_urls {
        let Some(captures) = TITLE_ID_RE.captures(&title_url) else {
            continue;
        };
        let raw_title_id = captures[1].to_ascii_lowercase();
        let normalized_title_id =
            normalize_designator(Some(&raw_title_id)).unwrap_or(raw_title_id.clone());
        titles.push(UscUnitRoot {
            id: format!("title-{normalized_title_id}"),
            title_num: normalized_title_id,
            url: title_url,
        });
    }

    if titles.is_empty() {
        return Err("Failed to parse any title identifiers from CGA title URLs.".to_string());
    }

    titles.sort_by_key(|title| designator_sort_order(&title.title_num));

    let root_node = NodeMeta {
        id: format!("{SOURCE_CODE}/{version_id}/root"),
        source_version_id: String::new(),
        parent_id: None,
        level_name: "root".to_string(),
        level_index: -1,
        sort_order: 0,
        name: Some(SOURCE_NAME.to_string()),
        path: Some("/statutes/cgs".to_string()),
        readable_id: Some("CGS".to_string()),
        heading_citation: Some("CGS".to_string()),
        source_url: Some(start_url.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id,
        root_node,
        unit_roots: titles,
    })
}

// fetch_titles_page removed as it is replaced by Fetcher trait usage

fn extract_version_id(html: &str) -> String {
    for pattern in VERSION_PATTERNS.iter() {
        if let Some(captures) = pattern.captures(html) {
            return captures[1].to_string();
        }
    }
    chrono::Utc::now().format("%Y").to_string()
}

fn extract_title_urls(html: &str, base_url: &str) -> Result<Vec<String>, String> {
    let base = reqwest::Url::parse(base_url)
        .map_err(|e| format!("Invalid CGA base URL `{base_url}`: {e}"))?;

    let mut urls = Vec::new();
    for captures in TITLE_HREF_RE.captures_iter(html) {
        let href = &captures[1];
        let absolute = base
            .join(href)
            .map_err(|e| format!("Failed to resolve CGA title URL `{href}`: {e}"))?
            .to_string();
        if !urls.contains(&absolute) {
            urls.push(absolute);
        }
    }
    Ok(urls)
}

pub fn cga_titles_page_url() -> &'static str {
    CGA_TITLES_PAGE_URL
}

#[cfg(test)]
mod tests {
    use super::{extract_title_urls, extract_version_id};
    use std::fs;
    use std::path::Path;

    fn load_titles_fixture() -> String {
        fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../data/cga_mirror/current/pub/titles.htm"),
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
        let title_urls = extract_title_urls(&html, "https://www.cga.ct.gov/current/pub/titles.htm")
            .expect("extract_title_urls should succeed");

        assert!(!title_urls.is_empty());
        assert_eq!(
            title_urls[0],
            "https://www.cga.ct.gov/current/pub/title_01.htm"
        );
        assert!(title_urls
            .iter()
            .all(|url| url.starts_with("https://www.cga.ct.gov/current/pub/title_")));
        assert_eq!(
            title_urls.len(),
            title_urls
                .iter()
                .cloned()
                .collect::<std::collections::HashSet<_>>()
                .len()
        );
    }
}
