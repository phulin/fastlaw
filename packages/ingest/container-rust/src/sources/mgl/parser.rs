use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static DESIGNATOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^0*([0-9]+)([a-zA-Z]*)$").unwrap());
static SECTION_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Section\s+[0-9]+[a-zA-Z]*\.\s*").unwrap());

const SECTION_LEVEL_INDEX: i32 = 2;

// API response types - field names match the JSON API

#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
pub struct MglApiPartSummary {
    pub Code: String,
    pub Details: String,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
pub struct MglApiChapterSummary {
    pub Code: String,
    pub Details: String,
}

/// Section data from API (used for both summary in chapter list and full details)
#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
pub struct MglApiSection {
    pub Code: String,
    #[serde(default)]
    pub ChapterCode: Option<String>,
    #[serde(default)]
    #[serde(alias = "name")]
    pub Name: Option<String>,
    #[serde(default)]
    pub IsRepealed: bool,
    #[serde(default)]
    #[serde(alias = "text")]
    pub Text: Option<String>,
    #[serde(default)]
    pub Details: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
pub struct MglApiPart {
    pub Code: String,
    pub Name: String,
    pub FirstChapter: u32,
    pub LastChapter: u32,
    pub Chapters: Vec<MglApiChapterSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
pub struct MglApiChapter {
    pub Code: String,
    pub Name: String,
    #[serde(default)]
    pub IsRepealed: bool,
    pub StrickenText: Option<String>,
    pub Sections: Vec<MglApiSection>,
}

// Parsed types

#[derive(Debug, Clone)]
pub struct MglPart {
    pub part_code: String,
    pub part_name: String,
    pub part_api_url: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct MglChapter {
    pub chapter_code: String,
    pub chapter_name: String,
    pub chapter_api_url: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct MglSection {
    pub section_code: String,
    pub chapter_code: String,
    pub section_api_url: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct MglSectionContent {
    pub heading: String,
    pub body: String,
}

// Parsing functions

pub fn parse_part_summary(input: &MglApiPartSummary, api_url: &str) -> MglPart {
    let part_code = normalize_designator(&input.Code);
    MglPart {
        part_code: part_code.clone(),
        part_name: String::new(),
        part_api_url: api_url.to_string(),
        sort_order: roman_to_int(&part_code),
    }
}

pub fn parse_part_detail(input: &MglApiPart, api_url: &str) -> MglPart {
    let part_code = normalize_designator(&input.Code);
    MglPart {
        part_code: part_code.clone(),
        part_name: normalize_text(&input.Name),
        part_api_url: api_url.to_string(),
        sort_order: roman_to_int(&part_code),
    }
}

pub fn parse_chapter_detail(input: &MglApiChapter, api_url: &str) -> MglChapter {
    let chapter_code = normalize_designator(&input.Code);
    MglChapter {
        chapter_code: chapter_code.clone(),
        chapter_name: normalize_text(&input.Name),
        chapter_api_url: api_url.to_string(),
        sort_order: designator_sort_order(&chapter_code),
    }
}

pub fn parse_section_summary(input: &MglApiSection, api_url: &str) -> MglSection {
    let section_code = normalize_designator(&input.Code);
    let chapter_code = normalize_designator(input.ChapterCode.as_deref().unwrap_or(""));
    MglSection {
        section_code: section_code.clone(),
        chapter_code,
        section_api_url: api_url.to_string(),
        sort_order: designator_sort_order(&section_code),
    }
}

pub fn parse_section_content(input: &MglApiSection) -> MglSectionContent {
    MglSectionContent {
        heading: normalize_text(input.Name.as_deref().unwrap_or("")),
        body: normalize_body_text(input.Text.as_deref().unwrap_or("")),
    }
}

// Helper functions

pub fn designator_sort_order(value: &str) -> i32 {
    let Some(captures) = DESIGNATOR_RE.captures(value) else {
        return i32::MAX;
    };

    let Ok(numeric) = captures[1].parse::<i32>() else {
        return i32::MAX;
    };

    let suffix = captures[2].to_ascii_lowercase();
    let mut suffix_value: i32 = 0;
    for ch in suffix.chars() {
        if !ch.is_ascii_lowercase() {
            return i32::MAX;
        }
        suffix_value = suffix_value
            .saturating_mul(27)
            .saturating_add((ch as i32) - ('a' as i32) + 1);
    }

    numeric.saturating_mul(100000).saturating_add(suffix_value)
}

fn roman_to_int(value: &str) -> i32 {
    match value.to_uppercase().as_str() {
        "I" => 1,
        "II" => 2,
        "III" => 3,
        "IV" => 4,
        "V" => 5,
        _ => i32::MAX,
    }
}

pub fn normalize_designator(value: &str) -> String {
    value.trim().replace(' ', "").to_uppercase()
}

fn normalize_text(value: &str) -> String {
    WHITESPACE_RE.replace_all(value.trim(), " ").into_owned()
}

pub fn normalize_body_text(value: &str) -> String {
    let text = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{a0}', '\u{202f}'], " ")
        .lines()
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join("\n")
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_string();

    // Strip leading "Section X." prefix (e.g., "Section 7A.")
    SECTION_PREFIX_RE.replace(&text, "").into_owned()
}

pub fn section_level_index() -> i32 {
    SECTION_LEVEL_INDEX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_designator_sort_order() {
        assert!(designator_sort_order("2A") > designator_sort_order("2"));
        assert!(designator_sort_order("10") > designator_sort_order("2A"));
    }

    #[test]
    fn test_normalize_designator() {
        assert_eq!(normalize_designator("  7a  "), "7A");
        assert_eq!(normalize_designator("7A"), "7A");
    }

    #[test]
    fn test_roman_to_int() {
        assert_eq!(roman_to_int("I"), 1);
        assert_eq!(roman_to_int("II"), 2);
        assert_eq!(roman_to_int("III"), 3);
        assert_eq!(roman_to_int("IV"), 4);
        assert_eq!(roman_to_int("V"), 5);
        assert_eq!(roman_to_int("VI"), i32::MAX);
    }

    #[test]
    fn test_normalize_body_text() {
        let input = "Section 7A. The governor may accept retrocession.\r\n\r\nA copy of the notice shall be filed.";
        let output = normalize_body_text(input);
        // The "Section 7A." prefix should be stripped
        assert!(!output.starts_with("Section 7A."));
        assert!(output.starts_with("The governor may accept retrocession."));
        assert!(output.contains("A copy of the notice shall be filed."));
    }
}
