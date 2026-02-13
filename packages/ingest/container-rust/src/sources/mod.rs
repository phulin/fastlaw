use crate::runtime::types::IngestContext;
use crate::types::{SourceKind, UnitEntry};
use async_trait::async_trait;

pub mod cga;
pub mod mgl;
pub mod usc;

#[async_trait]
pub trait SourceAdapter: Send + Sync {
    async fn discover(
        &self,
        client: &reqwest::Client,
        download_base: &str,
    ) -> Result<crate::types::DiscoveryResult, String>;

    async fn process_unit(
        &self,
        unit: &UnitEntry,
        context: &mut IngestContext<'_>,
        xml: &str,
    ) -> Result<(), String>;

    fn unit_label(&self, unit: &UnitEntry) -> String;

    /// Whether this source requires ZIP extraction when caching.
    /// USC and CGA download ZIP files from gov websites.
    /// MGL uses a JSON API and doesn't need ZIP extraction.
    fn needs_zip_extraction(&self) -> bool {
        true
    }
}

pub fn adapter_for(source: SourceKind) -> &'static (dyn SourceAdapter + Send + Sync) {
    match source {
        SourceKind::Usc => &usc::adapter::USC_ADAPTER,
        SourceKind::Cga => &cga::adapter::CGA_ADAPTER,
        SourceKind::Mgl => &mgl::adapter::MGL_ADAPTER,
    }
}
