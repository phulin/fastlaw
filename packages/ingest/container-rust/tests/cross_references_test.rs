use ingest::sources::usc::cross_references::{
    extract_section_cross_references, SectionCrossReference,
};

fn find_target<'a>(
    references: &'a [SectionCrossReference],
    section: &str,
    title_num: &str,
) -> Option<&'a SectionCrossReference> {
    references
        .iter()
        .find(|r| r.section == section && r.title_num.as_deref() == Some(title_num))
}

#[test]
fn parses_title_based_references() {
    let text = "See 42 U.S.C. 1983 and 18 U.S.C. 1001.";
    let refs = extract_section_cross_references(text, "42");

    let first = find_target(&refs, "1983", "42");
    assert!(first.is_some(), "Should find 42 USC 1983");
    let first = first.unwrap();
    assert_eq!(first.offset, text.find("1983").unwrap());
    assert_eq!(first.length, "1983".len());
    assert!(
        find_target(&refs, "1001", "18").is_some(),
        "Should find 18 USC 1001"
    );
}

#[test]
fn parses_relative_sections_with_explicit_title() {
    let text = "Section 552 of title 5 applies.";
    let refs = extract_section_cross_references(text, "1");

    let r = find_target(&refs, "552", "5");
    assert!(r.is_some(), "Should find section 552 of title 5");
    let r = r.unwrap();
    assert_eq!(r.offset, text.find("552").unwrap());
}

#[test]
fn parses_ranges_with_default_title() {
    let text = "Sections 101 to 103, inclusive, are reserved.";
    let refs = extract_section_cross_references(text, "12");

    assert!(
        find_target(&refs, "101", "12").is_some(),
        "Should find section 101"
    );
    assert!(
        find_target(&refs, "103", "12").is_some(),
        "Should find section 103"
    );
}
