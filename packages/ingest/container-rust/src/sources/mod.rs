use crate::runtime::fetcher::Fetcher;
use crate::runtime::types::{IngestContext, QueueItem};
use crate::types::{DiscoveryResult, SourceKind};
use async_trait::async_trait;

pub mod cgs;
pub mod common;
pub mod configs;
pub mod mgl;
pub mod usc;

#[async_trait]
pub trait SourceAdapter: Send + Sync {
    async fn discover(&self, fetcher: &dyn Fetcher, url: &str) -> Result<DiscoveryResult, String>;

    async fn process_url(
        &self,
        context: &mut IngestContext<'_>,
        item: &QueueItem,
    ) -> Result<(), String>;

    fn unit_label(&self, item: &QueueItem) -> String;

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
        SourceKind::Cgs => &cgs::adapter::CGS_ADAPTER,
        SourceKind::Mgl => &mgl::adapter::MGL_ADAPTER,
    }
}
