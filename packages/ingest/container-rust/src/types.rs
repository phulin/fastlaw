use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Usc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMeta {
    pub id: String,
    pub source_version_id: String,
    pub parent_id: Option<String>,
    pub level_name: String,
    pub level_index: i32,
    pub sort_order: i32,
    pub name: Option<String>,
    pub path: Option<String>,
    pub readable_id: Option<String>,
    pub heading_citation: Option<String>,
    pub source_url: Option<String>,
    pub accessed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePayload {
    pub meta: NodeMeta,
    pub content: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UscUnitRoot {
    pub id: String,
    pub title_num: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub version_id: String,
    pub root_node: NodeMeta,
    pub unit_roots: Vec<UscUnitRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestConfig {
    pub source: SourceKind,
    pub source_id: String,
    pub selectors: Option<Vec<String>>,
    pub units: Option<Vec<UnitEntry>>,
    pub callback_base: String,
    pub callback_token: String,
    pub source_version_id: Option<String>,
    pub root_node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitEntry {
    pub unit_id: String,
    pub url: String,
    pub sort_order: i32,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionContent {
    pub blocks: Vec<ContentBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<SectionMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionMetadata {
    pub cross_references: Vec<crate::sources::usc::cross_references::SectionCrossReference>,
}
