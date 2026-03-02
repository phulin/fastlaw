use crate::runtime::fetcher::Fetcher;
use crate::types::{DiscoveryResult, NodeMeta, UnitRoot};
use serde::Deserialize;

const MIN_CONGRESS: u32 = 106;
// Rate: 33 req/sec stays safely under govinfo's 40 req/sec limit.
const GOVINFO_PAGE_SIZE: u32 = 100;

#[derive(Debug, Deserialize)]
struct CollectionsResponse {
    packages: Vec<PackageSummary>,
    #[serde(rename = "nextPage")]
    next_page: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PackageSummary {
    #[serde(rename = "packageId")]
    package_id: String,
    #[serde(rename = "lastModified")]
    last_modified: String,
    congress: Option<String>,
    #[allow(dead_code)]
    #[serde(rename = "dateIssued")]
    date_issued: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PackageDetail {
    volume: Option<String>,
    congress: Option<String>,
    session: Option<String>,
    #[serde(rename = "dateIssued")]
    date_issued: Option<String>,
    #[serde(rename = "lastModified")]
    last_modified: Option<String>,
    download: Option<PackageDownload>,
}

#[derive(Debug, Deserialize)]
struct PackageDownload {
    #[serde(rename = "uslmLink")]
    uslm_link: Option<String>,
}

/// Appends the govinfo API key to a URL as a query parameter.
fn with_api_key(url: &str, api_key: &str) -> String {
    if url.contains('?') {
        format!("{}&api_key={}", url, api_key)
    } else {
        format!("{}?api_key={}", url, api_key)
    }
}

/// Fetches all STATUTE packages from the govinfo collections API for congress >= MIN_CONGRESS.
pub async fn discover_uspl_root(
    fetcher: &dyn Fetcher,
    collections_url: &str,
    api_key: &str,
) -> Result<DiscoveryResult, String> {
    let mut all_packages: Vec<PackageSummary> = Vec::new();

    // Paginate through the collections API
    let first_url = with_api_key(
        &format!(
            "{}?pageSize={}&offsetMark=*",
            collections_url, GOVINFO_PAGE_SIZE
        ),
        api_key,
    );
    let mut next_url: Option<String> = Some(first_url);

    while let Some(url) = next_url {
        let body = fetcher.fetch(&url).await?;
        let resp: CollectionsResponse = serde_json::from_str(&body).map_err(|e| {
            format!(
                "Failed to parse collections response: {e}\nBody: {}",
                &body[..body.len().min(500)]
            )
        })?;

        for pkg in resp.packages {
            let congress = pkg
                .congress
                .as_deref()
                .and_then(|c| c.parse::<u32>().ok())
                .unwrap_or(0);
            if congress >= MIN_CONGRESS {
                all_packages.push(pkg);
            }
        }

        next_url = resp.next_page.map(|u| with_api_key(&u, api_key));
    }

    if all_packages.is_empty() {
        return Err("No STATUTE packages found for congress >= 106".to_string());
    }

    // Compute version_id from the latest lastModified across all packages
    let latest_modified = all_packages
        .iter()
        .map(|p| p.last_modified.as_str())
        .max()
        .unwrap_or("1999-01-01T00:00:00Z");
    let version_id = &latest_modified[..10]; // "YYYY-MM-DD"

    // Fetch package details for each (volume number, USLM URL)
    // Group by congress for ordering, then sort by volume within congress
    let mut unit_roots: Vec<UnitRoot> = Vec::new();

    for pkg in &all_packages {
        let detail_url = with_api_key(
            &format!(
                "https://api.govinfo.gov/packages/{}/summary",
                pkg.package_id
            ),
            api_key,
        );
        let body = fetcher.fetch(&detail_url).await?;
        let detail: PackageDetail = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse package detail for {}: {e}", pkg.package_id))?;

        let volume = detail
            .volume
            .as_deref()
            .unwrap_or("0")
            .parse::<u32>()
            .unwrap_or(0);
        let congress = detail
            .congress
            .as_deref()
            .and_then(|c| c.parse::<u32>().ok())
            .unwrap_or(0);
        let session = detail
            .session
            .as_deref()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(1);
        let date_issued = detail.date_issued.as_deref().unwrap_or("").to_string();
        let last_modified = detail
            .last_modified
            .as_deref()
            .unwrap_or(&pkg.last_modified)
            .to_string();

        let uslm_url = match detail.download.and_then(|d| d.uslm_link) {
            Some(u) => with_api_key(&u, api_key),
            None => {
                eprintln!("No USLM link for {}, skipping", pkg.package_id);
                continue;
            }
        };

        // Encode all per-volume metadata into title_num as a pipe-separated string.
        // Format: "package_id|volume|congress|session|date_issued|last_modified"
        // This is carried through the orchestrator's QueueItem metadata["title_num"].
        let title_num = format!(
            "{}|{}|{}|{}|{}|{}",
            pkg.package_id, volume, congress, session, date_issued, last_modified
        );

        unit_roots.push(UnitRoot {
            id: format!("vol-{}", volume),
            title_num,
            url: uslm_url,
            level_name: "volume".to_string(),
            level_index: 0,
        });
    }

    // Sort by volume number ascending
    unit_roots.sort_by_key(|u| {
        u.title_num
            .split('|')
            .nth(1)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
    });

    let root_node_id = format!("uspl/{}", version_id);
    let root_node = NodeMeta {
        id: root_node_id,
        source_version_id: String::new(),
        parent_id: None,
        level_name: "root".to_string(),
        level_index: -1,
        sort_order: 0,
        name: Some("U.S. Public Laws".to_string()),
        path: Some("/".to_string()),
        readable_id: Some("USPL".to_string()),
        heading_citation: Some("U.S. Public Laws".to_string()),
        source_url: Some(collections_url.to_string()),
        accessed_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    Ok(DiscoveryResult {
        version_id: version_id.to_string(),
        root_node,
        unit_roots,
    })
}

/// Parse the pipe-delimited title_num field back into its components.
pub struct VolumeMetadata {
    pub package_id: String,
    pub volume: u32,
    pub congress: u32,
    pub session: u32,
    pub date_issued: String,
    pub last_modified: String,
}

impl VolumeMetadata {
    pub fn parse(title_num: &str) -> Option<Self> {
        let parts: Vec<&str> = title_num.split('|').collect();
        if parts.len() < 6 {
            return None;
        }
        Some(VolumeMetadata {
            package_id: parts[0].to_string(),
            volume: parts[1].parse().unwrap_or(0),
            congress: parts[2].parse().unwrap_or(0),
            session: parts[3].parse().unwrap_or(1),
            date_issued: parts[4].to_string(),
            last_modified: parts[5].to_string(),
        })
    }
}
