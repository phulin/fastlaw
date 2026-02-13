use crate::common::load_fixture;
use ingest::sources::cgs::cross_references::{
    extract_section_cross_references, inline_section_cross_references,
};
use ingest::sources::cgs::parser::{
    extract_chapter_title_from_html, extract_section_ids_from_toc, format_designator_display,
    format_designator_padded, normalize_designator, parse_cgs_chapter_html, parse_label,
    CgsUnitKind,
};
use std::fs;
use std::path::Path;

// ============================================================
// Designator Formatting Tests
// ============================================================

#[test]
fn pads_numeric_designators_with_zeros() {
    assert_eq!(
        format_designator_padded(Some("1"), 4).as_deref(),
        Some("0001")
    );
    assert_eq!(
        format_designator_padded(Some("42"), 4).as_deref(),
        Some("0042")
    );
    assert_eq!(
        format_designator_padded(Some("229"), 4).as_deref(),
        Some("0229")
    );
}

#[test]
fn handles_designators_with_letter_suffixes() {
    assert_eq!(
        format_designator_padded(Some("42a"), 4).as_deref(),
        Some("0042a")
    );
    assert_eq!(
        format_designator_padded(Some("377a"), 4).as_deref(),
        Some("0377a")
    );
    assert_eq!(
        format_designator_padded(Some("4c"), 4).as_deref(),
        Some("0004c")
    );
}

#[test]
fn handles_leading_zeros_in_input() {
    assert_eq!(
        format_designator_padded(Some("001"), 4).as_deref(),
        Some("0001")
    );
    assert_eq!(
        format_designator_padded(Some("042a"), 4).as_deref(),
        Some("0042a")
    );
}

#[test]
fn returns_none_for_none_input() {
    assert_eq!(format_designator_padded(None, 4), None);
}

#[test]
fn lowercases_letter_suffixes() {
    assert_eq!(
        format_designator_padded(Some("42A"), 4).as_deref(),
        Some("0042a")
    );
    assert_eq!(
        format_designator_padded(Some("377A"), 4).as_deref(),
        Some("0377a")
    );
}

#[test]
fn strips_leading_zeros_for_display() {
    assert_eq!(format_designator_display(Some("001")).as_deref(), Some("1"));
    assert_eq!(
        format_designator_display(Some("042")).as_deref(),
        Some("42")
    );
}

#[test]
fn handles_designators_with_letter_suffixes_for_display() {
    assert_eq!(
        format_designator_display(Some("042a")).as_deref(),
        Some("42a")
    );
    assert_eq!(
        format_designator_display(Some("377A")).as_deref(),
        Some("377a")
    );
}

#[test]
fn returns_none_for_none_display() {
    assert_eq!(format_designator_display(None), None);
}

#[test]
fn normalizes_designators_stripping_zeros_preserving_case() {
    assert_eq!(normalize_designator(Some("001")).as_deref(), Some("1"));
    assert_eq!(normalize_designator(Some("042A")).as_deref(), Some("42A"));
    assert_eq!(normalize_designator(Some("042a")).as_deref(), Some("42a"));
}

#[test]
fn sorts_designators_correctly() {
    let designators = vec!["42a", "4c", "377a", "1"];
    let mut sorted: Vec<_> = designators
        .iter()
        .map(|d| format_designator_padded(Some(d), 4).unwrap())
        .collect();
    sorted.sort();
    assert_eq!(sorted, vec!["0001", "0004c", "0042a", "0377a"]);
}

// ============================================================
// Label Parsing Tests
// ============================================================

#[test]
fn parses_single_section_labels() {
    let result = parse_label("Sec. 1-1. Words and phrases.");
    assert_eq!(result.number.as_deref(), Some("1-1"));
    assert_eq!(result.title.as_deref(), Some("Words and phrases."));
    assert_eq!(result.range_start.as_deref(), Some("1-1"));
    assert_eq!(result.range_end.as_deref(), Some("1-1"));
}

#[test]
fn parses_range_section_labels() {
    let result = parse_label("Secs. 1-1o to 1-1s. Reserved");
    assert_eq!(result.number.as_deref(), Some("1-1o to 1-1s"));
    assert_eq!(result.title.as_deref(), Some("Reserved"));
    assert_eq!(result.range_start.as_deref(), Some("1-1o"));
    assert_eq!(result.range_end.as_deref(), Some("1-1s"));
}

#[test]
fn handles_labels_without_title() {
    let result = parse_label("Sec. 1-15.");
    assert_eq!(result.number.as_deref(), Some("1-15"));
    assert_eq!(result.title, None);
}

#[test]
fn returns_none_for_invalid_labels() {
    let result = parse_label("Invalid label");
    assert_eq!(result.number, None);
    assert_eq!(result.title, None);
}

#[test]
fn returns_none_for_none_label() {
    let result = parse_label("");
    assert_eq!(result.number, None);
    assert_eq!(result.title, None);
}

// ============================================================
// Basic Section Extraction Tests
// ============================================================

#[test]
fn extracts_chapter_title() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let title = extract_chapter_title_from_html(&html);
    assert_eq!(title.as_deref(), Some("Doulas"));
}

#[test]
fn extracts_sections_from_html() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(
        &html,
        "377a",
        "https://www.cgs.ct.gov/current/pub/chap_377a.htm",
        CgsUnitKind::Chapter,
    );
    assert_eq!(sections.sections.len(), 2);
}

#[test]
fn extracts_section_string_id_correctly() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    assert_eq!(sections.sections[0].string_id, "cgs/section/20-86aa");
    assert_eq!(sections.sections[1].string_id, "cgs/section/20-86bb");
}

#[test]
fn extracts_section_name_from_toc() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    assert!(sections.sections[0]
        .name
        .as_ref()
        .map(|n| n.contains("Doula advisory committee"))
        .unwrap_or(false));
}

#[test]
fn sets_correct_parent_string_id() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    assert_eq!(sections.sections[0].parent_string_id, "cgs/chapter/377a");
}

#[test]
fn sets_correct_sort_order() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    assert_eq!(sections.sections[0].sort_order, 0);
    assert_eq!(sections.sections[1].sort_order, 1);
}

#[test]
fn excludes_nav_tbl_content_from_body() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    assert!(!sections.sections[0].body.contains("Return to Chapter"));
}

// ============================================================
// Reserved Sections Tests
// ============================================================

#[test]
fn extracts_reserved_sections() {
    let html = load_fixture("cgs/cgs_reserved_sections.htm");
    let sections = parse_cgs_chapter_html(&html, "001", "", CgsUnitKind::Chapter);
    let reserved_sections: Vec<_> = sections
        .sections
        .iter()
        .filter(|s| s.body.contains("Reserved for future use"))
        .collect();
    assert!(
        reserved_sections.len() >= 2,
        "Should find at least 2 reserved sections"
    );
}

#[test]
fn marks_reserved_sections_with_correct_string_id_pattern() {
    let html = load_fixture("cgs/cgs_reserved_sections.htm");
    let sections = parse_cgs_chapter_html(&html, "001", "", CgsUnitKind::Chapter);
    let reserved = sections
        .sections
        .iter()
        .find(|s| s.string_id.contains("1-1o_to_1-1s"));
    assert!(reserved.is_some(), "Should find reserved range section");
}

// ============================================================
// Transferred Sections Tests
// ============================================================

#[test]
fn extracts_transferred_sections() {
    let html = load_fixture("cgs/cgs_transferred_sections.htm");
    let sections = parse_cgs_chapter_html(&html, "003", "", CgsUnitKind::Chapter);
    let transferred: Vec<_> = sections
        .sections
        .iter()
        .filter(|s| s.body.contains("Transferred to Chapter"))
        .collect();
    assert!(
        transferred.len() >= 3,
        "Should find at least 3 transferred sections"
    );
}

#[test]
fn includes_transfer_destination_in_body() {
    let html = load_fixture("cgs/cgs_transferred_sections.htm");
    let sections = parse_cgs_chapter_html(&html, "003", "", CgsUnitKind::Chapter);
    let sec115 = sections
        .sections
        .iter()
        .find(|s| s.string_id == "cgs/section/1-15");
    assert!(sec115.is_some(), "Section 1-15 should be parsed");
    assert!(
        sec115.unwrap().body.contains("Transferred to Chapter 14"),
        "Should include transfer destination"
    );
}

// ============================================================
// Repealed Subsections Tests
// ============================================================

#[test]
fn includes_repealed_subsection_text_in_body() {
    let html = load_fixture("cgs/cgs_repealed_subsection.htm");
    let sections = parse_cgs_chapter_html(&html, "005", "", CgsUnitKind::Chapter);
    assert_eq!(sections.sections.len(), 1);
    assert!(sections.sections[0]
        .body
        .contains("Repealed by P.A. 76-186"));
}

// ============================================================
// Tables Tests
// ============================================================

#[test]
fn extracts_sections_containing_tables() {
    let html = load_fixture("cgs/cgs_tables_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "229", "", CgsUnitKind::Chapter);
    assert_eq!(sections.sections.len(), 1);
}

#[test]
fn converts_table_cells_with_pipe_separators() {
    let html = load_fixture("cgs/cgs_tables_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "229", "", CgsUnitKind::Chapter);
    let body = &sections.sections[0].body;
    assert!(body.contains('|'), "Tables should have | separators");
}

#[test]
fn preserves_table_content_like_tax_rates() {
    let html = load_fixture("cgs/cgs_tables_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "229", "", CgsUnitKind::Chapter);
    let body = &sections.sections[0].body;
    assert!(body.contains("Connecticut Taxable Income"));
    assert!(body.contains("Rate of Tax"));
    assert!(body.contains("3.0%"));
    assert!(body.contains("$2,250"));
}

#[test]
fn preserves_multiple_tables_in_one_section() {
    let html = load_fixture("cgs/cgs_tables_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "229", "", CgsUnitKind::Chapter);
    let body = &sections.sections[0].body;
    // Second table has $3,500 threshold
    assert!(body.contains("$3,500"));
    assert!(body.contains("$105.00"));
}

// ============================================================
// Nonstandard Level Names Tests
// ============================================================

#[test]
fn handles_chapter_designators_with_letter_suffixes() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    assert_eq!(sections.sections[0].parent_string_id, "cgs/chapter/377a");
}

#[test]
fn formats_nonstandard_designators_correctly_for_sorting() {
    assert_eq!(
        format_designator_padded(Some("42a"), 4).as_deref(),
        Some("0042a")
    );
    assert_eq!(
        format_designator_padded(Some("377a"), 4).as_deref(),
        Some("0377a")
    );
    assert_eq!(
        format_designator_padded(Some("4c"), 4).as_deref(),
        Some("0004c")
    );

    // Sorting order check
    let designators = vec!["42a", "4c", "377a", "1"];
    let mut sorted: Vec<_> = designators
        .iter()
        .map(|d| format_designator_padded(Some(d), 4).unwrap())
        .collect();
    sorted.sort();
    assert_eq!(sorted, vec!["0001", "0004c", "0042a", "0377a"]);
}

// ============================================================
// Title 42a (Uniform Commercial Code) - Articles Tests
// ============================================================

#[test]
fn extracts_sections_from_article_page() {
    let html = load_fixture("cgs/cgs_art_001.htm");
    let sections = parse_cgs_chapter_html(
        &html,
        "001",
        "https://www.cgs.ct.gov/current/pub/art_001.htm",
        CgsUnitKind::Article,
    );
    assert_eq!(sections.sections.len(), 2);
}

#[test]
fn extracts_correct_string_id_for_42a_sections() {
    let html = load_fixture("cgs/cgs_art_001.htm");
    let sections = parse_cgs_chapter_html(&html, "001", "", CgsUnitKind::Article);
    // Section IDs should preserve the 42a- prefix
    assert_eq!(sections.sections[0].string_id, "cgs/section/42a-1-101");
    assert_eq!(sections.sections[1].string_id, "cgs/section/42a-1-102");
}

#[test]
fn extracts_section_name_from_toc_for_42a_sections() {
    let html = load_fixture("cgs/cgs_art_001.htm");
    let sections = parse_cgs_chapter_html(&html, "001", "", CgsUnitKind::Article);
    assert!(sections.sections[0]
        .name
        .as_ref()
        .map(|n| n.contains("Short titles"))
        .unwrap_or(false));
    assert!(sections.sections[1]
        .name
        .as_ref()
        .map(|n| n.contains("Scope of article"))
        .unwrap_or(false));
}

#[test]
fn sets_correct_parent_string_id_for_articles() {
    let html = load_fixture("cgs/cgs_art_001.htm");
    let sections = parse_cgs_chapter_html(&html, "1", "", CgsUnitKind::Article);
    // For articles, parentStringId should reference cgs/article/...
    assert_eq!(sections.sections[0].parent_string_id, "cgs/article/1");
}

#[test]
fn sets_correct_parent_string_id_for_chapters_default() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    // For chapters, parentStringId should reference cgs/chapter/...
    assert_eq!(sections.sections[0].parent_string_id, "cgs/chapter/377a");
}

// ============================================================
// Framework Extension Points Tests
// ============================================================

#[test]
fn parsed_section_has_required_fields() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections =
        parse_cgs_chapter_html(&html, "377a", "http://example.com", CgsUnitKind::Chapter);
    let section = &sections.sections[0];

    // Required fields for DB insertion
    assert!(!section.string_id.is_empty());
    assert_eq!(section.level_name, "section");
    assert!(section.level_index >= 0);
    assert!(section.name.is_some());
    assert!(!section.path.is_empty());
    assert!(!section.readable_id.is_empty());
    assert!(!section.body.is_empty());
    assert!(!section.parent_string_id.is_empty());
    assert!(section.sort_order >= 0);
    assert!(!section.source_url.is_empty());
}

#[test]
fn section_level_index_is_consistent() {
    let html = load_fixture("cgs/cgs_basic_chapter.htm");
    let sections = parse_cgs_chapter_html(&html, "377a", "", CgsUnitKind::Chapter);
    // All sections should have levelIndex 2 (after root=0, title/chapter=1)
    for section in &sections.sections {
        assert_eq!(section.level_index, 2, "Section level_index should be 2");
    }
}

// ============================================================
// Cross-References Tests
// ============================================================

#[test]
fn extracts_section_cross_references() {
    let text = "See section 1-1 and sections 1-2 to 1-3, inclusive.";
    let refs = extract_section_cross_references(text);
    assert!(refs.len() >= 3, "Should find at least 3 references");
}

#[test]
fn inlines_cgs_cross_references() {
    let text = "See section 1-1 and sections 1-2 to 1-3, inclusive.";
    let inlined = inline_section_cross_references(text);
    assert!(inlined.contains("[1-1](/statutes/cgs/section/1-1)"));
    assert!(inlined.contains("[1-2](/statutes/cgs/section/1-2)"));
    assert!(inlined.contains("[1-3](/statutes/cgs/section/1-3)"));
}

// ============================================================
// Integration Tests with Real Mirror Data
// ============================================================

#[test]
fn parses_complex_mirror_chapter_001() {
    let chap_001 = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/cgs_mirror/current/pub/chap_001.htm"),
    )
    .expect("chapter 001 mirror should exist");
    let parsed_001 = parse_cgs_chapter_html(
        &chap_001,
        "001",
        "https://www.cgs.ct.gov/current/pub/chap_001.htm",
        CgsUnitKind::Chapter,
    );
    assert!(
        parsed_001.sections.len() > 20,
        "Chapter 1 should have many sections"
    );
}

#[test]
fn parses_complex_mirror_chapter_229() {
    let chap_229 = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/cgs_mirror/current/pub/chap_229.htm"),
    )
    .expect("chapter 229 mirror should exist");
    let parsed_229 = parse_cgs_chapter_html(
        &chap_229,
        "229",
        "https://www.cgs.ct.gov/current/pub/chap_229.htm",
        CgsUnitKind::Chapter,
    );
    assert!(
        parsed_229
            .sections
            .iter()
            .any(|section| section.body.contains("Connecticut Taxable Income")),
        "Chapter 229 should have tax table content"
    );
}

#[test]
fn parses_complex_mirror_chapter_003() {
    let chap_003 = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../data/cgs_mirror/current/pub/chap_003.htm"),
    )
    .expect("chapter 003 mirror should exist");
    let parsed_003 = parse_cgs_chapter_html(
        &chap_003,
        "003",
        "https://www.cgs.ct.gov/current/pub/chap_003.htm",
        CgsUnitKind::Chapter,
    );
    assert!(
        parsed_003
            .sections
            .iter()
            .any(|section| section.body.contains("Transferred to Chapter")),
        "Chapter 3 should have transferred sections"
    );
}

#[test]
fn extracts_toc_ids_for_title_42a_page() {
    let html = load_fixture("cgs/cgs_title_42a.htm");
    let toc_ids = extract_section_ids_from_toc(&html);
    assert!(
        toc_ids.is_empty(),
        "Title pages should not parse chapter TOC sections"
    );
}
