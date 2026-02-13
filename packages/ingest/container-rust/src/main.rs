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
