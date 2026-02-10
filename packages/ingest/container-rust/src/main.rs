use axum::{extract::Json, http::StatusCode, routing::post, Router};
use serde_json::json;
use usc_ingest::ingest::ingest_source;
use usc_ingest::types::IngestConfig;

async fn handle_ingest(Json(config): Json<IngestConfig>) -> (StatusCode, Json<serde_json::Value>) {
    tokio::spawn(async move {
        if let Err(err) = ingest_source(config).await {
            tracing::error!("[Container] Ingest failed: {}", err);
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
    let download_base = "https://uscode.house.gov/download/download.shtml"; // Default for now

    match params.source.as_str() {
        "usc" => {
            match usc_ingest::sources::usc::discover::discover_usc_root(&client, download_base)
                .await
            {
                Ok(result) => (StatusCode::OK, Json(json!(result))),
                Err(err) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": err })),
                ),
            }
        }
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
