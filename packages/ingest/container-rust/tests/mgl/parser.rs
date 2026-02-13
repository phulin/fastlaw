use ingest::sources::mgl::parser::{
    designator_sort_order, normalize_designator, parse_chapter_detail, parse_section_content,
    MglApiChapter, MglApiSection,
};

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
fn test_parse_chapter_detail() {
    let chapter = MglApiChapter {
        Code: "2A".to_string(),
        Name: "EMBLEMS".to_string(),
        IsRepealed: false,
        StrickenText: None,
        Sections: vec![],
    };
    let parsed = parse_chapter_detail(&chapter, "https://example.com/api/Chapters/2A");
    assert_eq!(parsed.chapter_code, "2A");
    assert_eq!(parsed.chapter_name, "EMBLEMS");
}

#[test]
fn test_parse_section_content() {
    let section = MglApiSection {
        Code: "7A".to_string(),
        ChapterCode: Some("1".to_string()),
        Name: Some("Legislative jurisdiction over property".to_string()),
        IsRepealed: false,
        Text: Some(
            "Section 7A. The governor may accept retrocession.\r\n\r\nA copy of the notice shall be filed."
                .to_string(),
        ),
        Details: None,
    };
    let content = parse_section_content(&section);
    assert_eq!(content.heading, "Legislative jurisdiction over property");
    // The "Section 7A." prefix should be stripped
    assert!(!content.body.starts_with("Section 7A."));
    assert!(content
        .body
        .starts_with("The governor may accept retrocession."));
    assert!(content
        .body
        .contains("A copy of the notice shall be filed."));
}
