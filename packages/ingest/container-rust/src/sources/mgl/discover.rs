use crate::sources::mgl::parser::{parse_part_detail, MglApiPart, MglApiPartSummary};
use crate::types::{DiscoveryResult, NodeMeta, UscUnitRoot};
use regex::Regex;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::LazyLock;

const MGL_BASE_URL: &str = "https://malegislature.gov";
const MGL_START_PATH: &str = "/Laws/GeneralLaws";
const SOURCE_CODE: &str = "mgl";
const SOURCE_NAME: &str = "Massachusetts General Laws";

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
    client: &Client,
    download_base: &str,
) -> Result<DiscoveryResult, String> {
    let start_url = format!("{}{}", MGL_BASE_URL, MGL_START_PATH);
    let root_html = fetch_landing_html(client, &start_url).await?;
    let version_id = extract_version_id_from_landing_html(&root_html);

    // Fetch parts list from API
    let parts_url = format!("{}/api/Parts", MGL_BASE_URL);
    let parts: Vec<MglApiPartSummary> = fetch_json(client, &parts_url).await?;

    let mut unit_roots: Vec<UscUnitRoot> = Vec::new();

    for part_summary in parts {
        let part_code = part_summary.Code.clone();
        let part_url = format!(
            "{}/api/Parts/{}",
            MGL_BASE_URL,
            urlencoding::encode(&part_code)
        );

        // Fetch part detail to get proper name
        let part_detail: MglApiPart = fetch_json(client, &part_url).await?;
        let parsed = parse_part_detail(&part_detail, &part_url);

        unit_roots.push(UscUnitRoot {
            id: format!("part-{}", parsed.part_code.to_lowercase()),
            title_num: parsed.part_code.clone(),
            url: parsed.part_api_url,
        });
    }

    // Sort by part code (Roman numeral order)
    unit_roots.sort_by_key(|unit| {
        let part_code = unit.title_num.clone();
        roman_sort_key(&part_code)
    });

    let root_node = NodeMeta {
        id: format!("{}/{}/root", SOURCE_CODE, version_id),
        source_version_id: String::new(),
        parent_id: None,
        level_name: "root".to_string(),
        level_index: -1,
        sort_order: 0,
        name: Some(SOURCE_NAME.to_string()),
        path: Some("/statutes/mgl".to_string()),
        readable_id: Some("MGL".to_string()),
        heading_citation: Some("MGL".to_string()),
        source_url: Some(download_base.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id,
        root_node,
        unit_roots,
    })
}

fn roman_sort_key(value: &str) -> i32 {
    match value.to_uppercase().as_str() {
        "I" => 1,
        "II" => 2,
        "III" => 3,
        "IV" => 4,
        "V" => 5,
        _ => i32::MAX,
    }
}

async fn fetch_landing_html(client: &Client, url: &str) -> Result<String, String> {
    let res = client
        .get(url)
        .header("User-Agent", "fastlaw-ingest/1.0")
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch MGL landing page: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("MGL landing page returned {}", res.status()));
    }

    res.text()
        .await
        .map_err(|e| format!("Failed to read MGL landing page body: {}", e))
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &Client,
    url: &str,
) -> Result<T, String> {
    let res = client
        .get(url)
        .header("User-Agent", "fastlaw-ingest/1.0")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch {}: {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("{} returned {}", url, res.status()));
    }

    res.json::<T>()
        .await
        .map_err(|e| format!("Failed to parse JSON from {}: {}", url, e))
}

pub fn extract_version_id_from_landing_html(html: &str) -> String {
    // Try to extract amendment date
    if let Some(caps) = AMENDMENT_DATE_RE.captures(html) {
        let month_name = caps[1].to_lowercase();
        let day = caps[2].parse::<u32>().unwrap_or(1);
        let year = caps[3].parse::<u32>().unwrap_or(2025);
        let month = MONTH_INDEX.get(month_name.as_str()).unwrap_or(&"01");
        return format!("{}-{}-{:02}", year, month, day);
    }

    // Fall back to copyright year
    if let Some(caps) = COPYRIGHT_YEAR_RE.captures(html) {
        let year = &caps[1];
        return format!("{}-01-01", year);
    }

    // Final fallback: current date
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

pub fn mgl_base_url() -> &'static str {
    MGL_BASE_URL
}

pub fn mgl_start_path() -> &'static str {
    MGL_START_PATH
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_version_id_from_amendment_date() {
        let html = "This site includes all amendments to the General Laws passed before <strong>January 10</strong><strong>, 2025</strong>, for laws enacted since that time";
        let version = extract_version_id_from_landing_html(html);
        assert_eq!(version, "2025-01-10");
    }

    #[test]
    fn test_extract_version_id_from_copyright() {
        let html = "Copyright &copy; 2024 Commonwealth of Massachusetts";
        let version = extract_version_id_from_landing_html(html);
        assert_eq!(version, "2024-01-01");
    }
}
