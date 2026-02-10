use crate::sources::usc::parser::title_sort_key;
use crate::types::{DiscoveryResult, NodeMeta, UscUnitRoot};
use regex::Regex;
use reqwest::Client;
use std::collections::HashMap;

const USC_DOWNLOAD_PAGE_URL: &str = "https://uscode.house.gov/download/download.shtml";
const SOURCE_CODE: &str = "usc";
const SOURCE_NAME: &str = "United States Code";

pub async fn discover_usc_root(
    client: &Client,
    download_base: &str,
) -> Result<DiscoveryResult, String> {
    let html = fetch_download_page(client).await?;
    let hrefs = extract_href_links(&html);

    let xml_link_re = Regex::new(r"(?i)xml_usc(\d{2}[a-z]?)@")
        .map_err(|e| format!("Failed to compile USC XML link regex: {e}"))?;
    let release_point_re = Regex::new(r"(?i)@(\d+-[^./?#\s]+)")
        .map_err(|e| format!("Failed to compile USC release point regex: {e}"))?;

    let mut by_title: HashMap<String, String> = HashMap::new();
    let mut release_points = std::collections::HashSet::new();

    for href in hrefs {
        let url = if href.starts_with("http") {
            href
        } else {
            format!("https://uscode.house.gov{}", href)
        };

        if let Some(caps) = xml_link_re.captures(&url) {
            let title_num = caps[1].trim_start_matches('0').to_string();
            let title_num = if title_num.is_empty() {
                "0".to_string()
            } else {
                title_num
            };

            if !by_title.contains_key(&title_num) {
                by_title.insert(title_num, url.clone());
            }

            if let Some(rp_caps) = release_point_re.captures(&url) {
                release_points.insert(rp_caps[1].to_string());
            }
        }
    }

    if by_title.is_empty() {
        return Err("Found no titles on USC download page.".to_string());
    }

    if release_points.is_empty() {
        return Err("Failed to determine USC release point from title URLs.".to_string());
    }

    if release_points.len() > 1 {
        return Err(format!(
            "Found multiple USC release points in one crawl: {}",
            release_points
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let release_point = release_points.into_iter().next().unwrap();
    let mut titles: Vec<_> = by_title.into_iter().collect();
    titles.sort_by(|(a, _), (b, _)| {
        let key_a = title_sort_key(a);
        let key_b = title_sort_key(b);
        key_a.partial_cmp(&key_b).unwrap()
    });

    let unit_roots: Vec<UscUnitRoot> = titles
        .into_iter()
        .map(|(title_num, url)| UscUnitRoot {
            id: format!("title-{}", title_num),
            title_num,
            url,
        })
        .collect();

    let root_node = NodeMeta {
        id: format!("{}/{}/root", SOURCE_CODE, release_point),
        source_version_id: String::new(), // To be filled by orchestrator/worker
        parent_id: None,
        level_name: "root".to_string(),
        level_index: -1,
        sort_order: 0,
        name: Some(SOURCE_NAME.to_string()),
        path: Some("/statutes/usc".to_string()),
        readable_id: Some("USC".to_string()),
        heading_citation: Some("USC".to_string()),
        source_url: Some(download_base.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id: release_point,
        root_node,
        unit_roots,
    })
}

async fn fetch_download_page(client: &Client) -> Result<String, String> {
    let res = client
        .get(USC_DOWNLOAD_PAGE_URL)
        .header("User-Agent", "fastlaw-ingest/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch USC download page: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("USC download page returned {}", res.status()));
    }

    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read USC download page body: {}", e))?;
    Ok(text)
}

fn extract_href_links(html: &str) -> Vec<String> {
    let mut links = Vec::new();
    let href_re = Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#).unwrap();
    for caps in href_re.captures_iter(html) {
        links.push(caps[1].to_string());
    }
    links
}
