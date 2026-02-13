use ingest::sources::mgl::cross_references::{
    extract_section_cross_references, inline_section_cross_references,
};

#[test]
fn test_extract_chapter_section_references() {
    let refs = extract_section_cross_references(
        "See chapter 268, section 1A and section 7 of chapter 90.",
    );
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].chapter, "268");
    assert_eq!(refs[0].section, "1A");
    assert_eq!(refs[0].link, "/statutes/mgl/chapter/268/section/1a");
    assert_eq!(refs[1].chapter, "90");
    assert_eq!(refs[1].section, "7");
    assert_eq!(refs[1].link, "/statutes/mgl/chapter/90/section/7");
}

#[test]
fn test_inline_section_cross_references() {
    let text = "See chapter 268, section 1A for details.";
    let inlined = inline_section_cross_references(text);
    assert!(inlined.contains("[chapter 268, section 1A]"));
    assert!(inlined.contains("/statutes/mgl/chapter/268/section/1a"));
}

#[test]
fn test_section_with_cross_references() {
    let text = "Section 7A. The governor may accept retrocession. See chapter 268, section 1A for related provisions.";
    let refs = extract_section_cross_references(text);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].chapter, "268");
    assert_eq!(refs[0].section, "1A");
}
