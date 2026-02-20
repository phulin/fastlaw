use crate::sources::nh::parser::{extract_version_id_from_landing_html, parse_title_links};
use crate::types::{DiscoveryResult, NodeMeta, UnitRoot};

const DEFAULT_START_URL: &str = "https://gc.nh.gov/rsa/html/nhtoc.htm";
const SOURCE_CODE: &str = "nh";
const SOURCE_NAME: &str = "New Hampshire Revised Statutes";

pub async fn discover_nh_root(
    fetcher: &dyn crate::runtime::fetcher::Fetcher,
    start_url: Option<&str>,
) -> Result<DiscoveryResult, String> {
    let start_url = start_url.unwrap_or(DEFAULT_START_URL);
    let html = fetcher.fetch(start_url).await?;
    let version_id =
        extract_version_id_from_landing_html(&html).unwrap_or_else(|| fallback_version_id(&html));
    let title_links = parse_title_links(&html, start_url)?;
    if title_links.is_empty() {
        return Err("Found no New Hampshire title links on statutes TOC page.".to_string());
    }

    let unit_roots = title_links
        .into_iter()
        .map(|title| UnitRoot {
            id: format!("title-{}", title.title_num.to_ascii_lowercase()),
            title_num: title.title_num,
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
        readable_id: Some("NH".to_string()),
        heading_citation: Some("N.H. RSA".to_string()),
        source_url: Some(start_url.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id,
        root_node,
        unit_roots,
    })
}

fn fallback_version_id(html: &str) -> String {
    format!("undated-{:016x}", fnv1a64(html.as_bytes()))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
