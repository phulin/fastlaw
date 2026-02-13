use ingest::sources::configs::SourcesConfig;
use ingest::types::SourceKind;

#[test]
fn test_load_config_with_source_kind_keys() {
    let json = r#"
    {
        "sources": {
            "usc": {
                "name": "United States Code",
                "jurisdiction": "federal",
                "region": "US",
                "doc_type": "statute",
                "description": "Federal statutory law of the United States",
                "root_url": "https://uscode.house.gov/download/download.shtml"
            },
            "cgs": {
                "name": "Connecticut General Statutes",
                "jurisdiction": "state",
                "region": "CT",
                "doc_type": "statute",
                "description": "Connecticut state statutory law",
                "root_url": "https://www.cga.ct.gov/current/pub/titles.htm"
            }
        }
    }
    "#;

    let config: SourcesConfig = serde_json::from_str(json).expect("Failed to parse config");

    assert_eq!(
        config.get_root_url(SourceKind::Usc),
        Some("https://uscode.house.gov/download/download.shtml")
    );
    // Note: The key in JSON is "cgs" which maps to SourceKind::Cgs
    assert_eq!(
        config.get_root_url(SourceKind::Cgs),
        Some("https://www.cga.ct.gov/current/pub/titles.htm")
    );
    assert_eq!(config.get_root_url(SourceKind::Mgl), None);
}
