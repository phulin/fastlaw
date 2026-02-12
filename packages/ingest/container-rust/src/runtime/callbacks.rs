use crate::types::NodePayload;
use reqwest::Client;

pub async fn callback_fetch(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    path: &str,
    method: reqwest::Method,
    body: Option<serde_json::Value>,
) -> Result<reqwest::Response, String> {
    let url = format!("{callback_base}{path}");
    let mut builder = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {callback_token}"));

    if let Some(json_body) = body {
        builder = builder
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&json_body).unwrap());
    }

    builder
        .send()
        .await
        .map_err(|e| format!("Request to {url} failed: {e}"))
}

pub(crate) async fn post_debug_log(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    level: &str,
    message: &str,
    context: Option<serde_json::Value>,
) {
    let body = serde_json::json!({
        "level": level,
        "message": message,
        "context": context,
    });

    let result = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/containerLog",
        reqwest::Method::POST,
        Some(body),
    )
    .await;
    if let Err(err) = result {
        eprintln!(
            "[Container][stderr] post_debug_log failed: level={} message={} err={}",
            level, message, err
        );
    }
}

pub async fn post_node_batch(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    unit_id: &str,
    nodes: &[NodePayload],
) -> Result<(), String> {
    let res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/insertNodeBatch",
        reqwest::Method::POST,
        Some(serde_json::json!({ "unitId": unit_id, "nodes": nodes })),
    )
    .await?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Insert callback failed: {text}"));
    }

    Ok(())
}

pub async fn post_unit_start(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    unit_id: &str,
    total_nodes: usize,
) -> Result<(), String> {
    let res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/unitStart",
        reqwest::Method::POST,
        Some(serde_json::json!({ "unitId": unit_id, "totalNodes": total_nodes })),
    )
    .await?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Unit start callback failed: {text}"));
    }

    Ok(())
}

pub async fn post_unit_progress(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    unit_id: &str,
    status: &str,
    error: Option<&str>,
) {
    let body = match error {
        Some(error_message) => serde_json::json!({
            "unitId": unit_id,
            "status": status,
            "error": error_message,
        }),
        None => serde_json::json!({
            "unitId": unit_id,
            "status": status,
        }),
    };

    let _ = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/progress",
        reqwest::Method::POST,
        Some(body),
    )
    .await;
}

pub async fn post_ensure_source_version(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    source_id: &str,
    source_version_id: &str,
    root_node: &crate::types::NodeMeta,
    units: &[crate::types::UscUnitRoot],
) -> Result<(), String> {
    let res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/ensureSourceVersion",
        reqwest::Method::POST,
        Some(serde_json::json!({
            "sourceId": source_id,
            "sourceVersionId": source_version_id,
            "rootNode": root_node,
            "units": units,
        })),
    )
    .await?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Ensure source version callback failed: {text}"));
    }

    Ok(())
}

pub async fn post_container_stop(
    client: &Client,
    callback_base: &str,
    callback_token: &str,
    reason: &str,
) -> Result<(), String> {
    let res = callback_fetch(
        client,
        callback_base,
        callback_token,
        "/api/callback/containerStop",
        reqwest::Method::POST,
        Some(serde_json::json!({ "reason": reason })),
    )
    .await?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Container stop callback failed: {text}"));
    }

    Ok(())
}
