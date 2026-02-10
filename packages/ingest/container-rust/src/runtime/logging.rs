use crate::runtime::callbacks::post_debug_log;
use crate::types::IngestConfig;
use reqwest::Client;
use reqwest::Url;

#[derive(Clone, Copy)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

fn is_local_callback_base(callback_base: &str) -> bool {
    let host = match Url::parse(callback_base) {
        Ok(url) => url.host_str().unwrap_or_default().to_string(),
        Err(_) => callback_base.to_string(),
    };

    host == "localhost" || host == "127.0.0.1" || host == "host.docker.internal"
}

pub async fn log_event_with_callback(
    client: &Client,
    callback_base: Option<&str>,
    callback_token: Option<&str>,
    level: LogLevel,
    message: &str,
    context: Option<serde_json::Value>,
) {
    match level {
        LogLevel::Debug => tracing::debug!("[Container] {}", message),
        LogLevel::Info => tracing::info!("[Container] {}", message),
        LogLevel::Warn => tracing::warn!("[Container] {}", message),
        LogLevel::Error => tracing::error!("[Container] {}", message),
    }

    if let (Some(base), Some(token)) = (callback_base, callback_token) {
        if is_local_callback_base(base) {
            post_debug_log(client, base, token, level.as_str(), message, context).await;
        }
    }
}

pub async fn log_event(
    client: &Client,
    config: &IngestConfig,
    level: LogLevel,
    message: &str,
    context: Option<serde_json::Value>,
) {
    log_event_with_callback(
        client,
        Some(&config.callback_base),
        Some(&config.callback_token),
        level,
        message,
        context,
    )
    .await;
}
