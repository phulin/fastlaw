use axum::{
    extract::{Json, State},
    http::StatusCode,
    routing::post,
    Router,
};
use ingest::ingest::ingest_source;
use ingest::runtime::callbacks::post_ingest_error;
use ingest::runtime::logging::{log_event_with_callback, LogLevel};
use ingest::types::IngestConfig;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;

struct AppState {
    active_jobs: AtomicUsize,
    total_jobs_started: AtomicUsize,
    shutdown_notify: Arc<Notify>,
}

async fn handle_ingest(
    State(state): State<Arc<AppState>>,
    Json(config): Json<IngestConfig>,
) -> (StatusCode, Json<serde_json::Value>) {
    let callback_base = config.callback_base.clone();
    let callback_token = config.callback_token.clone();
    let callback_base_for_join = callback_base.clone();
    let callback_token_for_join = callback_token.clone();

    // Increment active jobs and total count strictly before spawning
    state.active_jobs.fetch_add(1, Ordering::SeqCst);
    state.total_jobs_started.fetch_add(1, Ordering::SeqCst);

    let state_for_task = state.clone();

    // Spawn the ingest task
    let handle = tokio::spawn(async move {
        let ingest_result = ingest_source(config).await;

        if let Err(err) = &ingest_result {
            tracing::error!("[Container] Ingest failed: {}", err);
            let client = reqwest::Client::new();
            post_ingest_error(&client, &callback_base, &callback_token, err).await;
        }
    });

    // Spawn a monitor task to handle completion/failure and cleanup
    tokio::spawn(async move {
        if let Err(err) = handle.await {
            tracing::error!("[Container] Ingest task panicked or was cancelled: {}", err);
            let client = reqwest::Client::new();
            post_ingest_error(
                &client,
                &callback_base_for_join,
                &callback_token_for_join,
                &err.to_string(),
            )
            .await;
            log_event_with_callback(
                &client,
                Some(&callback_base_for_join),
                Some(&callback_token_for_join),
                LogLevel::Error,
                "ingest_task_panicked_or_cancelled",
                Some(json!({ "error": err.to_string() })),
            )
            .await;
        }

        // Decrement job count
        let previous = state_for_task.active_jobs.fetch_sub(1, Ordering::SeqCst);

        // If previous was 1 (so now 0), start the idle timer
        if previous == 1 {
            let current_generation = state_for_task.total_jobs_started.load(Ordering::SeqCst);
            let state_for_timeout = state_for_task.clone();

            tokio::spawn(async move {
                tracing::info!(
                    "[Container] No active jobs, waiting 15s for new jobs before shutdown..."
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;

                if state_for_timeout.active_jobs.load(Ordering::SeqCst) == 0
                    && state_for_timeout.total_jobs_started.load(Ordering::SeqCst)
                        == current_generation
                {
                    tracing::info!("[Container] Still no active jobs after 15s, shutting down.");
                    state_for_timeout.shutdown_notify.notify_one();
                } else {
                    tracing::info!("[Container] New jobs detected, cancelling idle shutdown.");
                }
            });
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

    let active_jobs = AtomicUsize::new(0);
    let total_jobs_started = AtomicUsize::new(0);
    let shutdown_notify = Arc::new(Notify::new());
    let state = Arc::new(AppState {
        active_jobs,
        total_jobs_started,
        shutdown_notify: shutdown_notify.clone(),
    });

    // Initial idle timeout: if no jobs target us within 15s of startup, shut down.
    let state_for_startup = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
        if state_for_startup.active_jobs.load(Ordering::SeqCst) == 0
            && state_for_startup.total_jobs_started.load(Ordering::SeqCst) == 0
        {
            tracing::info!("[Container] No jobs received within 15s of startup, shutting down.");
            state_for_startup.shutdown_notify.notify_one();
        }
    });

    let app = Router::new()
        .route("/ingest", post(handle_ingest))
        .fallback(handle_health)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("Failed to bind to port 8080");

    tracing::info!("[Container] Listening on :8080");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_notify))
        .await
        .expect("Server failed");
}

async fn shutdown_signal(notify: Arc<Notify>) {
    notify.notified().await;
}
