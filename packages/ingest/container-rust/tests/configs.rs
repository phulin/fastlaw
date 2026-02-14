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

#[test]
fn test_load_default_with_env_var() {
    use std::io::Write;
    use tempfile::NamedTempFile;

    let json = r#"
    {
        "sources": {
            "mgl": {
                "name": "Massachusetts General Laws",
                "jurisdiction": "state",
                "region": "MA",
                "doc_type": "statute",
                "description": "Massachusetts state statutory law",
                "root_url": "https://malegislature.gov/Laws/GeneralLaws"
            }
        }
    }
    "#;

    let mut tmp_file = NamedTempFile::new().expect("Failed to create temp file");
    write!(tmp_file, "{}", json).expect("Failed to write to temp file");

    // NamedTempFile creates a file in a temp dir. We need to rename it to 'sources.json'
    // in that dir to test the directory-based loading.
    let temp_dir = tmp_file.path().parent().unwrap().to_path_buf();
    let sources_json_path = temp_dir.join("sources.json");
    std::fs::write(&sources_json_path, json).expect("Failed to write sources.json");

    std::env::set_var("CONFIGS_PATH", temp_dir.to_str().unwrap());
    let config = SourcesConfig::load_default().expect("Failed to load default config");
    std::env::remove_var("CONFIGS_PATH");
    let _ = std::fs::remove_file(sources_json_path);

    assert_eq!(
        config.get_root_url(SourceKind::Mgl),
        Some("https://malegislature.gov/Laws/GeneralLaws")
    );
}
