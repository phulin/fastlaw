use crate::sources::mgl::parser::MglApiPartSummary;
use crate::types::{DiscoveryResult, NodeMeta, UnitRoot};
use chrono::Datelike;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

const MGL_BASE_URL: &str = "https://malegislature.gov";
const MGL_START_PATH: &str = "/Laws/GeneralLaws";

static MONTH_INDEX: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    map.insert("january", "01");
    map.insert("february", "02");
    map.insert("march", "03");
    map.insert("april", "04");
    map.insert("may", "05");
    map.insert("june", "06");
    map.insert("july", "07");
    map.insert("august", "08");
    map.insert("september", "09");
    map.insert("october", "10");
    map.insert("november", "11");
    map.insert("december", "12");
    map
});

static AMENDMENT_DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)This site includes all amendments to the General Laws passed before\s*<strong>\s*([A-Za-z]+)\s+(\d{1,2})\s*</strong>\s*<strong>\s*,\s*(\d{4})\s*</strong>"
    ).expect("AMENDMENT_DATE_RE should compile")
});

static COPYRIGHT_YEAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Copyright\s*&copy;\s*(\d{4})").expect("COPYRIGHT_YEAR_RE should compile")
});

pub async fn discover_mgl_root(
    fetcher: &dyn crate::runtime::fetcher::Fetcher,
    parts_url: &str,
) -> Result<DiscoveryResult, String> {
    let start_url = format!("{}{}", MGL_BASE_URL, MGL_START_PATH);
    let root_html = fetcher.fetch(&start_url).await?;
    let version_id = extract_version_id_from_landing_html(&root_html);

    // Fetch parts list from API
    let parts_json = fetcher.fetch(&parts_url).await?;
    let parts: Vec<MglApiPartSummary> = serde_json::from_str(&parts_json)
        .map_err(|e| format!("Failed to parse MGL parts list: {e}"))?;

    let mut unit_roots: Vec<UnitRoot> = Vec::new();

    for part_summary in parts {
        unit_roots.push(UnitRoot {
            id: format!("part-{}", part_summary.Code.to_lowercase()),
            title_num: part_summary.Code,
            url: part_summary.Details,
            level_name: "part".to_string(),
            level_index: 0,
        });
    }

    let root_node = NodeMeta {
        id: format!("mgl/{}/root", version_id),
        source_version_id: String::new(),
        parent_id: None,
        level_name: "root".to_string(),
        level_index: -1,
        sort_order: 0,
        name: Some("Massachusetts General Laws".to_string()),
        path: Some("/statutes/mgl".to_string()),
        readable_id: Some("MGL".to_string()),
        heading_citation: Some("MGL".to_string()),
        source_url: Some(parts_url.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id,
        root_node,
        unit_roots,
    })
}

// Helper functions removed as they are replaced by Fetcher trait usage

pub fn extract_version_id_from_landing_html(html: &str) -> String {
    let today = chrono::Utc::now();

    // Try to extract amendment date
    if let Some(caps) = AMENDMENT_DATE_RE.captures(html) {
        let month_name = caps[1].to_lowercase();
        let day = caps[2].parse::<u32>().unwrap_or(today.month());
        let year = caps[3].parse::<u32>().unwrap_or(today.year_ce().1);
        let month = MONTH_INDEX.get(month_name.as_str()).unwrap_or(&"01");
        return format!("{}-{}-{:02}", year, month, day);
    }

    // Fall back to copyright year
    if let Some(caps) = COPYRIGHT_YEAR_RE.captures(html) {
        let year = &caps[1];
        return format!("{}-01-01", year);
    }

    // Final fallback: current date
    today.format("%Y-%m-%d").to_string()
}
