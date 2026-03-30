use crate::runtime::callbacks::callback_fetch;
use reqwest::Client;
use std::io::{Cursor, Read};

fn extract_xml_from_zip(file_bytes: &[u8], url: &str) -> Result<String, String> {
    let cursor = Cursor::new(file_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open ZIP from {url}: {e}"))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read ZIP entry {index} from {url}: {e}"))?;

        if !file.name().to_ascii_lowercase().ends_with(".xml") {
            continue;
        }

        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| format!("Failed to read XML entry {} from {url}: {e}", file.name()))?;
        return Ok(content);
    }

    Err(format!("No XML entry found in ZIP from {url}"))
}

pub async fn ensure_cached(
    client: &Client,
    url: &str,
    callback_base: &str,
    callback_token: &str,
    extract_zip: bool,
    cache_key: &str,
    throttle_requests_per_second: Option<u32>,
) -> Result<Option<String>, String> {
    let cache_read_res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/proxy/cache-read",
        reqwest::Method::POST,
        Some({
            let mut body = serde_json::json!({
                "url": url,
                "extractZip": extract_zip,
                "cacheKey": cache_key,
            });
            if let Some(rps) = throttle_requests_per_second {
                body["throttleRequestsPerSecond"] = serde_json::json!(rps);
            }
            body
        }),
    )
    .await?;

    let status = cache_read_res.status();

    if status.as_u16() == 422 {
        let body: serde_json::Value = cache_read_res
            .json()
            .await
            .map_err(|e| format!("Failed to parse 422 response: {e}"))?;

        if body.get("error").and_then(|v| v.as_str()) == Some("html_response") {
            return Ok(None);
        }

        return Err("Cache proxy failed: 422".to_string());
    }

    if !status.is_success() {
        let text = cache_read_res.text().await.unwrap_or_default();
        return Err(format!("Cache proxy failed: {status} {text}"));
    }

    let file_bytes = cache_read_res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read file bytes: {e}"))?;

    let content = if extract_zip {
        extract_xml_from_zip(&file_bytes, url)?
    } else {
        String::from_utf8(file_bytes.to_vec())
            .map_err(|e| format!("File bytes are not valid UTF-8: {e}"))?
    };

    Ok(Some(content))
}
