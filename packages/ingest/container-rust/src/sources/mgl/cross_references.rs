use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionCrossReference {
    pub section: String,
    pub chapter: String,
    pub offset: usize,
    pub length: usize,
    pub link: String,
}

static CHAPTER_SECTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bchapter\s+(\d+[a-zA-Z]?)\s*,\s*section\s+(\d+[a-zA-Z]?)\b")
        .expect("CHAPTER_SECTION_RE should compile")
});

static OF_CHAPTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bsection\s+(\d+[a-zA-Z]?)\s+of\s+chapter\s+(\d+[a-zA-Z]?)\b")
        .expect("OF_CHAPTER_RE should compile")
});

fn normalize_designator(value: &str) -> String {
    value.trim().to_uppercase()
}

fn make_link(chapter: &str, section: &str) -> String {
    format!(
        "/statutes/chapter/{}/section/{}",
        chapter.to_lowercase(),
        section.to_lowercase()
    )
}

pub fn extract_section_cross_references(text: &str) -> Vec<SectionCrossReference> {
    let mut refs = Vec::new();

    // Pattern: "chapter X, section Y"
    for caps in CHAPTER_SECTION_RE.captures_iter(text) {
        let full = match caps.get(0) {
            Some(f) => f,
            None => continue,
        };
        let chapter = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let section = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if chapter.is_empty() || section.is_empty() {
            continue;
        }
        let chapter = normalize_designator(chapter);
        let section = normalize_designator(section);
        refs.push(SectionCrossReference {
            chapter: chapter.clone(),
            section: section.clone(),
            offset: full.start(),
            length: full.end() - full.start(),
            link: make_link(&chapter, &section),
        });
    }

    // Pattern: "section X of chapter Y"
    for caps in OF_CHAPTER_RE.captures_iter(text) {
        let full = match caps.get(0) {
            Some(f) => f,
            None => continue,
        };
        let section = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let chapter = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if chapter.is_empty() || section.is_empty() {
            continue;
        }
        let chapter = normalize_designator(chapter);
        let section = normalize_designator(section);
        refs.push(SectionCrossReference {
            chapter: chapter.clone(),
            section: section.clone(),
            offset: full.start(),
            length: full.end() - full.start(),
            link: make_link(&chapter, &section),
        });
    }

    // Dedupe
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    for reference in refs {
        let key = format!(
            "{}:{}:{}:{}",
            reference.chapter, reference.section, reference.offset, reference.link
        );
        if seen.insert(key) {
            deduped.push(reference);
        }
    }

    deduped.sort_by_key(|r| r.offset);
    deduped
}

/// Inlines cross-references as markdown links in the text
pub fn inline_section_cross_references(text: &str) -> String {
    let mut references = extract_section_cross_references(text);
    references.sort_by(|a, b| b.offset.cmp(&a.offset));

    let mut output = text.to_string();
    for reference in references {
        let start = reference.offset;
        let end = start.saturating_add(reference.length);
        if end > output.len()
            || start >= end
            || !output.is_char_boundary(start)
            || !output.is_char_boundary(end)
        {
            continue;
        }

        let label = &output[start..end];
        let linked = format!("[{label}]({})", reference.link);
        output.replace_range(start..end, &linked);
    }

    output
}
