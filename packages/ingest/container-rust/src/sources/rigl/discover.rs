use crate::sources::rigl::parser::{extract_version_id_from_landing_html, parse_title_links};
use crate::types::{DiscoveryResult, NodeMeta, UnitRoot};

const DEFAULT_START_URL: &str = "https://webserver.rilegislature.gov/statutes/Statutes.html";
const SOURCE_CODE: &str = "rigl";
const SOURCE_NAME: &str = "Rhode Island General Laws";

pub async fn discover_rigl_root(
    fetcher: &dyn crate::runtime::fetcher::Fetcher,
    start_url: Option<&str>,
) -> Result<DiscoveryResult, String> {
    let start_url = start_url.unwrap_or(DEFAULT_START_URL);
    let html = fetcher.fetch(start_url).await?;
    let version_id = extract_version_id_from_landing_html(&html)
        .unwrap_or_else(|| chrono::Utc::now().format("%Y").to_string());
    let title_links = parse_title_links(&html, start_url)?;

    if title_links.is_empty() {
        return Err("Found no title unit links on RI statutes landing page.".to_string());
    }

    let unit_roots = title_links
        .into_iter()
        .map(|title| UnitRoot {
            id: format!("title-{}", title.title_num.to_ascii_lowercase()),
            title_num: title.title_num.clone(),
            url: title.url,
            level_name: "title".to_string(),
            level_index: 0,
        })
        .collect::<Vec<_>>();

    let root_node = NodeMeta {
        id: format!("{SOURCE_CODE}/{version_id}/root"),
        source_version_id: String::new(),
        parent_id: None,
        level_name: "root".to_string(),
        level_index: -1,
        sort_order: 0,
        name: Some(SOURCE_NAME.to_string()),
        path: Some("/".to_string()),
        readable_id: Some("RIGL".to_string()),
        heading_citation: Some("RIGL".to_string()),
        source_url: Some(start_url.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id,
        root_node,
        unit_roots,
    })
}
