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

async fn handle_health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let app = Router::new()
        .route("/ingest", post(handle_ingest))
        .fallback(handle_health);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("Failed to bind to port 8080");

    tracing::info!("[Container] Listening on :8080");

    axum::serve(listener, app).await.expect("Server failed");
}
