use std::fs;
use std::path::Path;
use usc_ingest::sources::usc::parser::usc_level_index;
use usc_ingest::sources::usc::parser::{parse_usc_xml, USCParentRef};

fn fixtures_dir() -> &'static str {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")
}

fn load_fixture(filename: &str) -> String {
    let path = Path::new(fixtures_dir()).join(filename);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read fixture {}: {}", path.display(), e))
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
    assert_eq!(result.title_name, "GENERAL PROVISIONS");
}

#[test]
fn falls_back_to_main_title_heading_when_meta_title_is_empty() {
    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
            <meta><title><![CDATA[]]></title></meta>
            <main><title identifier="/us/usc/t99"><heading>TEST TITLE HEADING</heading></title></main>
        </uscDoc>"#;
    let result = parse_usc_xml(xml, "99", "");
    assert_eq!(result.title_name, "TEST TITLE HEADING");
}

#[test]
fn bolds_leading_outline_markers_in_section_body() {
    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
            <main>
                <title identifier="/us/usc/t99">
                    <section identifier="/us/usc/t99/s1">
                        <num value="1">§ 1.</num>
                        <heading>Test section</heading>
                        <content>
                            <subsection><num>(a)</num>General rule.</subsection>
                            <subsection><num>(1)</num>First item.</subsection>
                            <paragraph><num>(A)</num>Upper item.</paragraph>
                        </content>
                    </section>
                </title>
            </main>
        </uscDoc>"#;
    let result = parse_usc_xml(xml, "99", "");
    let section = result.sections.first().expect("section should exist");
    assert!(section.body.contains("**(a)**General rule."));
    assert!(section.body.contains("**(1)**First item."));
    assert!(section.body.contains("**(A)**Upper item."));
}

#[test]
fn inserts_line_break_before_nested_outline_marker_after_colon() {
    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
            <main>
                <title identifier="/us/usc/t99">
                    <section identifier="/us/usc/t99/s1">
                        <num value="1">§ 1.</num>
                        <heading>Test section</heading>
                        <subsection>
                            <num>(a)</num>
                            <content>Intro text:</content>
                            <paragraph>
                                <num>(1)</num>
                                <content>First item.</content>
                            </paragraph>
                        </subsection>
                    </section>
                </title>
            </main>
        </uscDoc>"#;

    let result = parse_usc_xml(xml, "99", "");
    let section = result.sections.first().expect("section should exist");
    assert!(section.body.contains("Intro text:\n\n**(1)**"));
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
    let section_nums: Vec<&str> = result
        .sections
        .iter()
        .map(|s| s.section_num.as_str())
        .collect();
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
    assert_eq!(section1.section_key, "1:1");

    // Parent linkage (sections in chapter 1 should have chapter parent)
    match &section1.parent_ref {
        USCParentRef::Level { level_type, .. } => {
            assert_eq!(level_type, "chapter");
        }
        USCParentRef::Title { .. } => {
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
        section201
            .body
            .contains("**Publishing in slip or pamphlet form or in Statutes at Large.\u{2014}**"),
        "Section 201 body should contain formatted heading. Body: {}",
        &section201.body[..200.min(section201.body.len())]
    );
    // Spec says exclude section heading itself.
    assert!(
        !section201
            .body
            .contains("Publication and distribution of Code of Laws"),
        "Section 201 body should NOT contain the section heading itself"
    );
}

#[test]
fn extracts_source_credit_as_history_short() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let sections_with_history: Vec<_> = result
        .sections
        .iter()
        .filter(|s| !s.source_credit.is_empty())
        .collect();
    assert!(
        !sections_with_history.is_empty(),
        "At least some sections should have source credits"
    );
}

#[test]
fn extracts_amendments_and_notes() {
    let xml = load_fixture("usc_title_1.xml");
    let result = parse_usc_xml(&xml, "1", "https://uscode.house.gov/");
    let section201 = result
        .sections
        .iter()
        .find(|s| s.section_num == "201")
        .expect("201 found");

    // Check amendments (from topic="amendments")
    assert!(
        !section201.amendments.is_empty(),
        "Section 201 should have amendment notes"
    );
    assert!(section201.amendments.contains("1984\u{2014}Subsec. (a)"));

    // Check notes (other notes)
    assert!(
        !section201.note.is_empty(),
        "Section 201 should have general notes"
    );
    assert!(section201.note.contains("Change of Name"));
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
    assert_eq!(chapter1.identifier, "1-title/chapter-1");
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
#[test]
fn handles_nested_sections_and_dashes_and_newlines() {
    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
            <main>
                <title identifier="/us/usc/t99">
                    <section identifier="/us/usc/t99/s1437f">
                        <num value="1437f">§ 1437f.</num>
                        <heading>Main Heading</heading>
                        <content>
                            <p>Para 1:</p>
                        </content>
                        <subsection>
                            <num>(a)</num>
                            <content>Subpara text</content>
                        </subsection>
                        <notes>
                            <note>
                                <heading>Note Heading</heading>
                                <p>Note text with nested section:</p>
                                <quotedContent>
                                    <section identifier="/us/usc/t42/s511">
                                        <num value="511">SEC. 511.</num>
                                        <heading>NESTED HEADING</heading>
                                        <content><p>Nested body</p></content>
                                    </section>
                                </quotedContent>
                            </note>
                        </notes>
                    </section>
                    <section identifier="/us/usc/t99/s1437f–1">
                        <num value="1437f–1">§ 1437f–1.</num>
                        <heading>Repealed</heading>
                    </section>
                </title>
            </main>
        </uscDoc>"#;

    let result = parse_usc_xml(xml, "99", "");

    // 1. Verify isolation: Parent section should keep its heading
    let s1 = result
        .sections
        .iter()
        .find(|s| s.section_num == "1437f")
        .unwrap();
    assert_eq!(s1.heading, "Main Heading");

    // 2. Verify newlines: (a) and "Subpara text" should be in the same block (no extra \n\n)
    // Actually, the current logic for `subsection` with `num` and `content` tags:
    // `handle_start` for `subsection`: pushes nothing if no text.
    // `num` in body: pushes `**`.
    // text in `num` (a): pushes `(a)`.
    // `num` end: pushes `**`.
    // `content` start: pushes nothing (removed from SECTION_BODY_TAGS).
    // text in `content`: pushes `Subpara text`.
    // `subsection` end: trims and pushes to `body_parts`.
    // 2. Verify newlines: (a) and "Subpara text" should be in the same block (no extra \n\n)
    assert!(s1.body.contains("**(a)** Subpara text"));
    assert!(!s1.body.contains("**(a)**\n\nSubpara text"));

    // 3. Verify dash normalization
    let s2 = result
        .sections
        .iter()
        .find(|s| s.section_num == "1437f-1")
        .unwrap();
    assert_eq!(s2.path, "/statutes/usc/section/99/1437f-1");
}

#[test]
fn test_url_collision_overlapping_parts() {
    let xml = r#"<?xml version="1.0"?>
        <uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t10">
            <main>
                <title identifier="/us/usc/t10">
                    <subtitle identifier="/us/usc/t10/stA">
                        <num value="A">SUBTITLE A</num>
                        <part identifier="/us/usc/t10/stA/ptI">
                            <num value="I">PART I</num>
                            <section identifier="/us/usc/t10/stA/ptI/s101">
                                <num value="101">§ 101.</num>
                                <heading>Section in Subtitle A Part I</heading>
                             </section>
                        </part>
                    </subtitle>
                    <subtitle identifier="/us/usc/t10/stB">
                        <num value="B">SUBTITLE B</num>
                        <part identifier="/us/usc/t10/stB/ptI">
                            <num value="I">PART I</num>
                            <section identifier="/us/usc/t10/stB/ptI/s101">
                                <num value="101">§ 101.</num>
                                <heading>Section in Subtitle B Part I</heading>
                             </section>
                        </part>
                    </subtitle>
                </title>
            </main>
        </uscDoc>"#;

    let result = usc_ingest::sources::usc::parser::parse_usc_xml(xml, "10", "");

    let parts: Vec<_> = result
        .levels
        .iter()
        .filter(|l| l.level_type == "part")
        .collect();
    assert_eq!(parts.len(), 2, "Should have 2 parts");

    // Check identifiers
    assert_ne!(
        parts[0].identifier, parts[1].identifier,
        "Part identifiers should be unique"
    );
    assert_eq!(parts[0].identifier, "10-title/subtitle-A/part-I");
    assert_eq!(parts[1].identifier, "10-title/subtitle-B/part-I");

    // Check paths
    assert_ne!(parts[0].path, parts[1].path, "Part paths should be unique");
    assert_eq!(parts[0].path, "/statutes/usc/10/subtitle-A/part-I");
    assert_eq!(parts[1].path, "/statutes/usc/10/subtitle-B/part-I");

    // Check sections
    assert_eq!(result.sections.len(), 2);
    assert_ne!(
        result.sections[0].path, result.sections[1].path,
        "Section paths should be unique"
    );
    assert_eq!(result.sections[0].path, "/statutes/usc/section/10/101");
    assert_eq!(result.sections[1].path, "/statutes/usc/section/10/101-2");
}
