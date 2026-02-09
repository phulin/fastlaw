use crate::runtime::types::{BuildContext, PreparedNodes};
use crate::types::{SourceKind, UnitEntry};

pub mod usc;

pub trait SourceAdapter: Send + Sync {
    fn build_nodes(
        &self,
        unit: &UnitEntry,
        context: &BuildContext,
        xml: &str,
    ) -> Result<PreparedNodes, String>;

    fn unit_label(&self, unit: &UnitEntry) -> String;
}

pub fn adapter_for(source: SourceKind) -> &'static (dyn SourceAdapter + Send + Sync) {
    match source {
        SourceKind::Usc => &usc::adapter::USC_ADAPTER,
    }
}
