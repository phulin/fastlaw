use crate::types::IngestConfig;

pub async fn ingest_source(config: IngestConfig) -> Result<(), String> {
    crate::runtime::orchestrator::ingest_source(config).await
}
