use async_trait::async_trait;
use reqwest::Client;

#[async_trait]
pub trait Fetcher: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<String, String>;
}

pub struct HttpFetcher {
    client: Client,
}

impl HttpFetcher {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl Fetcher for HttpFetcher {
    async fn fetch(&self, url: &str) -> Result<String, String> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Network error fetching {url}: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "HTTP error {} fetching {url}",
                response.status().as_u16()
            ));
        }

        response
            .text()
            .await
            .map_err(|e| format!("Error reading response body from {url}: {e}"))
    }
}
