use crate::types::NodePayload;

pub struct BuildContext<'a> {
    pub source_version_id: &'a str,
    pub root_node_id: &'a str,
    pub accessed_at: &'a str,
    pub unit_sort_order: i32,
}

pub struct PreparedNodes {
    pub structure_nodes: Vec<NodePayload>,
    pub section_nodes: Vec<NodePayload>,
}

pub enum UnitStatus {
    Completed,
    Skipped,
}

impl UnitStatus {
    pub fn as_str(&self) -> &str {
        match self {
            UnitStatus::Completed => "completed",
            UnitStatus::Skipped => "skipped",
        }
    }
}
