use std::fs;
use std::path::Path;
use usc_ingest::parser::{parse_usc_xml, usc_level_index};

fn fixtures_dir() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")
}

fn load_fixture(filename: &str) -> String {
    let path = Path::new(fixtures_dir()).join(filename);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("Failed to read fixture {}: {}", path.display(), e))
}

#[test]
fn extracts_correct_title_number() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    assert_eq!(result.title_num, "1");
}

#[test]
fn extracts_title_name() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    assert_eq!(result.title_name, "Title 1");
}

#[test]
fn extracts_chapters_as_organizational_levels() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    assert!(!result.levels.is_empty());
    let chapters: Vec<_> = result
        .levels
        .iter()
        .filter(|l| l.level_type == "chapter")
        .collect();
    assert_eq!(chapters.len(), 3);
}

#[test]
fn assigns_correct_level_indices() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    for level in &result.levels {
        assert_eq!(
            level.level_index,
            usc_level_index(&level.level_type).unwrap(),
            "Level {} has wrong index",
            level.level_type
        );
    }
}

#[test]
fn extracts_sections() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    assert!(!result.sections.is_empty());
    // Title 1 has around 39 sections
    assert!(
        result.sections.len() >= 35,
        "Expected >= 35 sections, got {}",
        result.sections.len()
    );
}

#[test]
fn extracts_section_numbers_correctly() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let section_nums: Vec<&str> = result.sections.iter().map(|s| s.section_num.as_str()).collect();
    assert!(section_nums.contains(&"1"));
    assert!(section_nums.contains(&"2"));
    assert!(section_nums.contains(&"3"));
}

#[test]
fn extracts_section_1_with_correct_structure() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let section1 = result
        .sections
        .iter()
        .find(|s| s.section_num == "1")
        .expect("Section 1 not found");

    // Body content
    assert!(
        section1.body.len() > 100,
        "Section 1 body too short: {}",
        section1.body.len()
    );
    assert!(
        section1.body.contains("meaning"),
        "Section 1 body should contain 'meaning'"
    );

    // Paths and IDs
    assert_eq!(section1.path, "/statutes/usc/section/1/1");
    assert_eq!(section1.doc_id, "doc_usc_1-1");
    assert_eq!(section1.section_key, "1:1");

    // Parent linkage (sections in chapter 1 should have chapter parent)
    match &section1.parent_ref {
        usc_ingest::parser::USCParentRef::Level { level_type, .. } => {
            assert_eq!(level_type, "chapter");
        }
        usc_ingest::parser::USCParentRef::Title { .. } => {
            panic!("Expected level parent, got title parent");
        }
    }
}

#[test]
fn extracts_section_201_heading() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let section201 = result
        .sections
        .iter()
        .find(|s| s.section_num == "201")
        .expect("Section 201 not found");
    assert_eq!(
        section201.heading,
        "Publication and distribution of Code of Laws of United States and Supplements and District of Columbia Code and Supplements"
    );
    assert!(
        section201.body.contains("**Publishing in slip or pamphlet form or in Statutes at Large.\u{2014}**"),
        "Section 201 body should contain formatted heading. Body: {}",
        &section201.body[..200.min(section201.body.len())]
    );
}

#[test]
fn extracts_source_credit_as_history_short() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let sections_with_history: Vec<_> = result
        .sections
        .iter()
        .filter(|s| !s.history_short.is_empty())
        .collect();
    assert!(
        !sections_with_history.is_empty(),
        "At least some sections should have source credits"
    );
}

#[test]
fn sets_chapter_identifiers_correctly() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let chapter1 = result
        .levels
        .iter()
        .find(|l| l.level_type == "chapter" && l.num == "1")
        .expect("Chapter 1 not found");
    assert_eq!(chapter1.identifier, "1-ch1");
    assert_eq!(chapter1.title_num, "1");
}

#[test]
fn links_chapters_to_title_as_parent() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    for level in &result.levels {
        if level.level_type == "chapter" {
            assert_eq!(
                level.parent_identifier.as_deref(),
                Some("1-title"),
                "Chapter {} should have parent 1-title",
                level.num
            );
        }
    }
}

#[test]
fn returns_empty_results_for_invalid_xml() {
    let result = parse_usc_xml("<invalid>not usc xml</invalid>", "1", "");
    assert!(result.sections.is_empty());
    assert!(result.levels.is_empty());
}

#[test]
fn handles_xml_with_no_sections() {
    let minimal_xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
            <meta><title>Title 99</title></meta>
            <main><title identifier="/us/usc/t99"></title></main>
        </uscDoc>"#;
    let result = parse_usc_xml(minimal_xml, "99", "");
    assert!(result.sections.is_empty());
    assert_eq!(result.title_num, "99");
}

#[test]
fn drops_trailing_bracket_on_repealed_chapter_heading() {
    let xml = load_fixture("usc03.xml");
    let result = parse_usc_xml(&xml, "3", "https://uscode.house.gov/");
    let chapter3 = result
        .levels
        .iter()
        .find(|l| l.level_type == "chapter" && l.num == "3")
        .expect("Chapter 3 not found");
    assert_eq!(chapter3.heading, "REPEALED");
}

#[test]
fn drops_trailing_bracket_on_repealed_section_heading() {
    let xml = load_fixture("usc03.xml");
    let result = parse_usc_xml(&xml, "3", "https://uscode.house.gov/");
    let section2 = result
        .sections
        .iter()
        .find(|s| s.section_num == "2")
        .expect("Section 2 not found");
    // The XML contains &#x202f; (narrow no-break space) before "102(a)".
    // The TS test normalizes \u202f to regular space; here we match the actual output.
    let normalized = section2.heading.replace('\u{202f}', " ");
    assert_eq!(
        normalized,
        "Repealed. Pub. L. 117\u{2013}328, div. P, title I, \u{a7} 102(a), Dec. 29, 2022, 136 Stat. 5233"
    );
}
