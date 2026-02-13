use axum::{extract::Json, http::StatusCode, routing::post, Router};
use ingest::ingest::ingest_source;
use ingest::runtime::callbacks::post_container_stop;
use ingest::runtime::logging::{log_event_with_callback, LogLevel};
use ingest::types::IngestConfig;
use serde_json::json;

async fn handle_ingest(Json(config): Json<IngestConfig>) -> (StatusCode, Json<serde_json::Value>) {
    let callback_base = config.callback_base.clone();
    let callback_token = config.callback_token.clone();
    let callback_base_for_join = callback_base.clone();
    let callback_token_for_join = callback_token.clone();
    let handle = tokio::spawn(async move {
        let client = reqwest::Client::new();
        let ingest_result = ingest_source(config).await;

        if let Err(err) = &ingest_result {
            tracing::error!("[Container] Ingest failed: {}", err);
        }

        let stop_reason = if ingest_result.is_ok() {
            "ingest_completed"
        } else {
            "ingest_failed"
        };

        if let Err(err) =
            post_container_stop(&client, &callback_base, &callback_token, stop_reason).await
        {
            tracing::error!("[Container] Failed to request container stop: {}", err);
        }
    });
    tokio::spawn(async move {
        if let Err(err) = handle.await {
            tracing::error!("[Container] Ingest task panicked or was cancelled: {}", err);
            let client = reqwest::Client::new();
            log_event_with_callback(
                &client,
                Some(&callback_base_for_join),
                Some(&callback_token_for_join),
                LogLevel::Error,
                "ingest_task_panicked_or_cancelled",
                Some(json!({ "error": err.to_string() })),
            )
            .await;
            if let Err(err) = post_container_stop(
                &client,
                &callback_base_for_join,
                &callback_token_for_join,
                "ingest_panicked",
            )
            .await
            {
                tracing::error!("[Container] Failed to request container stop: {}", err);
            }
        }
    });

    (StatusCode::OK, Json(json!({ "status": "accepted" })))
}

#[derive(Debug, serde::Deserialize)]
struct DiscoverParams {
    source: String,
}

async fn handle_discover(
    Json(params): Json<DiscoverParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    let client = reqwest::Client::new();
    let usc_download_base = "https://uscode.house.gov/download/download.shtml";
    let cga_titles_page = ingest::sources::cga::discover::cga_titles_page_url();

    let fetcher = ingest::runtime::fetcher::HttpFetcher::new(client.clone());
    match params.source.as_str() {
        "usc" => {
            match ingest::sources::usc::discover::discover_usc_root(&fetcher, usc_download_base)
                .await
            {
                Ok(result) => (StatusCode::OK, Json(json!(result))),
                Err(err) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": err })),
                ),
            }
        }
        "cga" => match ingest::sources::cga::discover::discover_cga_root(&fetcher, cga_titles_page)
            .await
        {
            Ok(result) => (StatusCode::OK, Json(json!(result))),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err })),
            ),
        },
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Unknown source: {}", params.source) })),
        ),
    }
}
async fn handle_health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let app = Router::new()
        .route("/ingest", post(handle_ingest))
        .route("/discover", post(handle_discover))
        .fallback(handle_health);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("Failed to bind to port 8080");

    tracing::info!("[Container] Listening on :8080");

    axum::serve(listener, app).await.expect("Server failed");
}
