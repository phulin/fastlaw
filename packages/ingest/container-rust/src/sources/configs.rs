use crate::types::SourceKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConfig {
    pub name: String,
    pub jurisdiction: String,
    pub region: String,
    pub doc_type: String,
    pub description: String,
    pub root_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourcesConfig {
    pub sources: HashMap<SourceKind, SourceConfig>,
}

impl SourcesConfig {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read sources.json: {e}"))?;
        let config: SourcesConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse sources.json: {e}"))?;
        Ok(config)
    }

    pub fn get_root_url(&self, source: SourceKind) -> Option<&str> {
        self.sources.get(&source).map(|s| s.root_url.as_str())
    }
}
