use crate::common::load_fixture;
use ingest::sources::nh::parser::{
    compare_designators, inline_nh_cross_references, normalize_designator, normalize_text,
    normalize_text_for_comparison, parse_chapter_index, parse_merged_chapter_sections,
    parse_section_detail, parse_title_index, parse_title_links,
};
use std::cmp::Ordering;

#[test]
fn parses_title_links_from_nh_toc() {
    let html = load_fixture("nh/nhtoc.htm");
    let titles = parse_title_links(&html, "https://gc.nh.gov/rsa/html/nhtoc.htm")
        .expect("title links should parse");

    assert!(titles.len() > 60);
    assert_eq!(titles[0].title_num, "I");
    assert_eq!(titles[0].title_name, "THE STATE AND ITS GOVERNMENT");
    assert!(titles.iter().any(|title| title.title_num == "XXXIV-A"));
}

#[test]
fn parses_title_index_and_chapter_links() {
    let html = load_fixture("nh/title_i_toc.htm");
    let parsed = parse_title_index(&html, "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I.htm")
        .expect("title index should parse");

    assert_eq!(parsed.title_num, "I");
    assert_eq!(parsed.title_name, "THE STATE AND ITS GOVERNMENT");
    assert!(parsed.chapters.len() > 100);
    assert_eq!(parsed.chapters[0].chapter_num, "1");
    assert_eq!(parsed.chapters[0].chapter_name, "STATE BOUNDARIES");
}

#[test]
fn parses_chapter_index_and_section_links() {
    let html = load_fixture("nh/chapter_21-j_toc.htm");
    let parsed = parse_chapter_index(&html, "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-I-21-J.htm")
        .expect("chapter index should parse");

    assert_eq!(parsed.chapter_num, "21-J");
    assert_eq!(parsed.chapter_name, "DEPARTMENT OF REVENUE ADMINISTRATION");
    assert!(parsed.sections.len() > 40);
    assert_eq!(parsed.sections[0].section_num, "21-J:1");
    assert!(parsed
        .sections
        .iter()
        .any(|section| section.section_num == "21-J:6-a"));
}

#[test]
fn parses_single_section_and_routes_source_note() {
    let html = load_fixture("nh/section_21-j-31.htm");
    let parsed = parse_section_detail(&html).expect("section detail should parse");

    assert_eq!(parsed.title_num, "I");
    assert_eq!(parsed.chapter_num, "21-J");
    assert_eq!(parsed.section_num, "21-J:31");
    assert_eq!(parsed.section_name, "Penalty for Failure to File");
    assert!(parsed
        .body
        .contains("Any taxpayer who fails to file a return"));
    assert!(parsed
        .source_note
        .as_deref()
        .expect("source note should exist")
        .contains("1985, 204:1"));
}

#[test]
fn handles_repealed_sections_with_empty_codesect() {
    let html = load_fixture("nh/section_21-j-6-a.htm");
    let parsed = parse_section_detail(&html).expect("section detail should parse");
    assert_eq!(parsed.section_num, "21-J:6-a");
    assert!(parsed.section_name.contains("Repealed by 2016"));
    assert_eq!(parsed.body, parsed.section_name);
}

#[test]
fn parses_interstate_compact_and_preserves_bold_markers() {
    let html = load_fixture("nh/section_5-a-1.htm");
    let parsed = parse_section_detail(&html).expect("compact section should parse");
    assert_eq!(parsed.section_num, "5-A:1");
    assert!(parsed.body.contains("**Interpleader Compact**"));
    assert!(parsed.body.contains("**Article 1.Purpose.**"));
}

#[test]
fn parses_ucc_sections_from_merged_chapter_page() {
    let html = load_fixture("nh/chapter_382-a_mrg.htm");
    let parsed = parse_merged_chapter_sections(&html).expect("merged chapter should parse");
    assert!(parsed.len() > 10);
    assert_eq!(parsed[0].section_num, "382-A:1-101");
    assert_eq!(parsed[0].section_name, "Short Titles");
    assert!(parsed[0].body.contains("(a) This chapter may be cited"));
    assert!(parsed[0]
        .source_note
        .as_deref()
        .expect("source note should exist")
        .contains("2006, 169:1"));
}

#[test]
fn compares_designators_deterministically() {
    assert_eq!(compare_designators("21-J:6-a", "21-J:6-b"), Ordering::Less);
    assert_eq!(
        compare_designators("382-A:1-101", "382-A:1-102"),
        Ordering::Less
    );
    assert_eq!(compare_designators("5-A:1", "5-A:1"), Ordering::Equal);
}

#[test]
fn normalizes_designators_for_slugs() {
    assert_eq!(normalize_designator(" XXXIV-A "), "xxxiv-a");
    assert_eq!(normalize_designator("21-J:31"), "21-j-31");
}

#[test]
fn inlines_rsa_cross_references_to_section_paths() {
    let text = "This penalty is not applied as provided in RSA 77-A:9 or RSA 84-A:7.";
    let inlined = inline_nh_cross_references(text, "I");
    assert!(inlined.contains("[77-A:9](/title/i/chapter/77-a/section/77-a-9)"));
    assert!(inlined.contains("[84-A:7](/title/i/chapter/84-a/section/84-a-7)"));
}

#[test]
fn baseline_text_comparison_for_section_fixture() {
    let html = load_fixture("nh/section_21-j-31.htm");
    let parsed = parse_section_detail(&html).expect("section detail should parse");
    let baseline_body = normalize_text_for_comparison(&baseline_extract_codesect_text(&html));
    let parser_body = normalize_text_for_comparison(&parsed.body);
    assert_eq!(baseline_body, parser_body);
    assert!(parsed.source_note.is_some());
}

fn baseline_extract_codesect_text(html: &str) -> String {
    let dom = tl::parse(html, tl::ParserOptions::default()).expect("fixture HTML should parse");
    let parser = dom.parser();
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() == "codesect" {
            return normalize_text(&tag.inner_text(parser));
        }
    }
    String::new()
}
