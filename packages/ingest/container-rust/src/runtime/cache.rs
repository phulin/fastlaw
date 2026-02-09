use crate::runtime::callbacks::callback_fetch;
use reqwest::Client;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheResponse {
    pub r2_key: String,
}

pub async fn ensure_cached_xml(
    client: &Client,
    url: &str,
    callback_base: &str,
    callback_token: &str,
) -> Result<Option<CacheResponse>, String> {
    let cache_res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/proxy/cache",
        reqwest::Method::POST,
        Some(serde_json::json!({ "url": url, "extractZip": true })),
    )
    .await?;

    let status = cache_res.status();

    if status.as_u16() == 422 {
        let body: serde_json::Value = cache_res
            .json()
            .await
            .map_err(|e| format!("Failed to parse 422 response: {e}"))?;

        if body.get("error").and_then(|v| v.as_str()) == Some("html_response") {
            return Ok(None);
        }

        return Err("Cache proxy failed: 422".to_string());
    }

    if !status.is_success() {
        let text = cache_res.text().await.unwrap_or_default();
        return Err(format!("Cache proxy failed: {status} {text}"));
    }

    let cache_info: CacheResponse = cache_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse cache response: {e}"))?;

    Ok(Some(cache_info))
}

pub async fn read_cached_xml(
    client: &Client,
    cache: &CacheResponse,
    callback_base: &str,
    callback_token: &str,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&format!("{callback_base}/api/proxy/r2-read"))
        .map_err(|e| format!("Invalid callback base URL: {e}"))?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("key", &cache.r2_key);
    }

    let res = client
        .request(reqwest::Method::GET, url)
        .header("Authorization", format!("Bearer {callback_token}"))
        .send()
        .await
        .map_err(|e| format!("R2 read request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("R2 read failed: {}", res.status()));
    }

    let xml_bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read XML bytes: {e}"))?;

    String::from_utf8(xml_bytes.to_vec()).map_err(|e| format!("XML bytes are not valid UTF-8: {e}"))
}
