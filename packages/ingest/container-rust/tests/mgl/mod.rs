mod adapter;
mod cross_references;
mod discover;
mod parser;

pub(crate) fn prune_part_json(json: &str, keep_chapter_code: &str) -> String {
    let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
    if let Some(chapters) = value.get_mut("Chapters").and_then(|c| c.as_array_mut()) {
        chapters.retain(|c| c["Code"].as_str() == Some(keep_chapter_code));
    }
    serde_json::to_string(&value).unwrap()
}

pub(crate) fn prune_chapter_json(json: &str, keep_section_codes: &[&str]) -> String {
    let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
    if let Some(sections) = value.get_mut("Sections").and_then(|s| s.as_array_mut()) {
        sections.retain(|s| keep_section_codes.contains(&s["Code"].as_str().unwrap_or("")));
    }
    serde_json::to_string(&value).unwrap()
}
