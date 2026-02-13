use crate::sources::cgs::parser::{designator_sort_order, normalize_designator, CgsUnitKind};
use crate::types::{DiscoveryResult, NodeMeta, UnitRoot};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

const CGS_TITLES_PAGE_URL: &str = "https://www.cgs.ct.gov/current/pub/titles.htm";
const SOURCE_CODE: &str = "cgs";
const SOURCE_NAME: &str = "Connecticut General Statutes";

static TITLE_HREF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)href\s*=\s*["']([^"']*title_[^"']+\.htm)["']"#).unwrap());
static TITLE_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)title_([^.]+)\.htm").unwrap());
static CHAPTER_HREF_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)href\s*=\s*["']([^"']*(?:chap_|art_)[^"']+\.htm)["']"#).unwrap()
});
static CHAPTER_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:chap|art)_([^.]+)\.htm").unwrap());
static TITLE_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Title\s+[\w*]+\s*[-–—]\s*(.+)$").unwrap());
static VERSION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"(?i)revised\s+to\s+\w+\s+\d+,?\s+(\d{4})").unwrap(),
        Regex::new(r"(?i)current\s+through\s+.*?(\d{4})").unwrap(),
        Regex::new(r"(?i)as\s+of\s+.*?(\d{4})").unwrap(),
    ]
});

pub async fn discover_cgs_root(
    fetcher: &dyn crate::runtime::fetcher::Fetcher,
    start_url: &str,
) -> Result<DiscoveryResult, String> {
    let html = fetcher.fetch(start_url).await?;
    let version_id = extract_version_id(&html);
    let title_urls = extract_title_urls(&html, start_url)?;

    if title_urls.is_empty() {
        return Err("Found no CGS title pages on titles index.".to_string());
    }

    let mut titles = Vec::with_capacity(title_urls.len());
    for title_url in title_urls {
        let Some(captures) = TITLE_ID_RE.captures(&title_url) else {
            continue;
        };
        let raw_title_id = captures[1].to_ascii_lowercase();
        let normalized_title_id =
            normalize_designator(Some(&raw_title_id)).unwrap_or(raw_title_id.clone());
        titles.push(UnitRoot {
            id: format!("title-{normalized_title_id}"),
            title_num: normalized_title_id,
            url: title_url,
            level_name: "title".to_string(),
            level_index: 0,
        });
    }

    if titles.is_empty() {
        return Err("Failed to parse any title identifiers from CGS title URLs.".to_string());
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

pub fn extract_version_id(html: &str) -> String {
    for pattern in VERSION_PATTERNS.iter() {
        if let Some(captures) = pattern.captures(html) {
            return captures[1].to_string();
        }
    }
    chrono::Utc::now().format("%Y").to_string()
}

pub fn extract_title_urls(html: &str, base_url: &str) -> Result<Vec<String>, String> {
    let base = reqwest::Url::parse(base_url)
        .map_err(|e| format!("Invalid CGS base URL `{base_url}`: {e}"))?;

    let mut urls = Vec::new();
    for captures in TITLE_HREF_RE.captures_iter(html) {
        let href = &captures[1];
        let absolute = base
            .join(href)
            .map_err(|e| format!("Failed to resolve CGS title URL `{href}`: {e}"))?
            .to_string();
        if !urls.contains(&absolute) {
            urls.push(absolute);
        }
    }
    Ok(urls)
}

pub fn cgs_titles_page_url() -> &'static str {
    CGS_TITLES_PAGE_URL
}

pub struct ChapterUrl {
    pub url: String,
    pub unit_kind: CgsUnitKind,
    pub chapter_id: String,
}

/// Extract chapter/article URLs from a title page's HTML.
pub fn extract_chapter_urls(html: &str, base_url: &str) -> Result<Vec<ChapterUrl>, String> {
    let base = reqwest::Url::parse(base_url)
        .map_err(|e| format!("Invalid CGS base URL `{base_url}`: {e}"))?;

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for captures in CHAPTER_HREF_RE.captures_iter(html) {
        let href = &captures[1];
        let absolute = base
            .join(href)
            .map_err(|e| format!("Failed to resolve CGS chapter URL `{href}`: {e}"))?
            .to_string();
        if !seen.insert(absolute.clone()) {
            continue;
        }

        let unit_kind = CgsUnitKind::from_url(&absolute);
        let chapter_id = parse_chapter_id_from_url(&absolute).unwrap_or_default();
        let normalized_id =
            normalize_designator(Some(&chapter_id)).unwrap_or_else(|| chapter_id.clone());

        results.push(ChapterUrl {
            url: absolute,
            unit_kind,
            chapter_id: normalized_id,
        });
    }
    Ok(results)
}

/// Parse the chapter/article ID from a CGS URL like `.../chap_123.htm` or `.../art_45a.htm`.
pub fn parse_chapter_id_from_url(url: &str) -> Option<String> {
    CHAPTER_ID_RE
        .captures(url)
        .map(|c| c[1].to_ascii_lowercase())
}

/// Extract title name from the `<title>` tag of a title page.
/// Expects format like "Title 5 - Some Name".
pub fn extract_title_name_from_html(html: &str) -> Option<String> {
    let title_re: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<title>([^<]+)</title>").unwrap());
    let captures = title_re.captures(html)?;
    let full_title = captures[1].trim();
    let name_captures = TITLE_NAME_RE.captures(full_title)?;
    Some(name_captures[1].trim().to_string())
}
