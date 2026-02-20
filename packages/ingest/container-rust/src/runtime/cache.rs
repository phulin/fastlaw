use crate::runtime::callbacks::callback_fetch;
use reqwest::Client;

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
        Some(serde_json::json!({
            "url": url,
            "extractZip": extract_zip,
            "cacheKey": cache_key,
            "throttleRequestsPerSecond": throttle_requests_per_second
        })),
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

    let content = String::from_utf8(file_bytes.to_vec())
        .map_err(|e| format!("File bytes are not valid UTF-8: {e}"))?;

    Ok(Some(content))
}
