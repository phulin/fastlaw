use async_trait::async_trait;
use ingest::runtime::types::Logger;
use ingest::{debug, error, info, warn};
use serde_json::Value;
use std::sync::{Arc, Mutex};

struct MockLogger {
    logs: Arc<Mutex<Vec<(String, String)>>>,
}

#[async_trait]
impl Logger for MockLogger {
    async fn log(&self, level: &str, message: &str, _context: Option<Value>) {
        let mut logs = self.logs.lock().unwrap();
        logs.push((level.to_string(), message.to_string()));
    }
}

struct MockContext {
    logger: Arc<dyn Logger>,
}

#[tokio::test]
async fn test_logging_macros() {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let logger = Arc::new(MockLogger { logs: logs.clone() });
    let context = MockContext { logger };

    info!(context, "info message {}", 1);
    warn!(context, "warn message {}", 2);
    error!(context, "error message {}", 3);
    debug!(context, "debug message {}", 4);

    let logs = logs.lock().unwrap();
    assert_eq!(logs.len(), 4);
    assert_eq!(logs[0], ("info".to_string(), "info message 1".to_string()));
    assert_eq!(logs[1], ("warn".to_string(), "warn message 2".to_string()));
    assert_eq!(
        logs[2],
        ("error".to_string(), "error message 3".to_string())
    );
    assert_eq!(
        logs[3],
        ("debug".to_string(), "debug message 4".to_string())
    );
}
