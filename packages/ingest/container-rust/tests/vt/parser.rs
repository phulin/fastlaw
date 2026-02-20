use crate::common::load_fixture;
use ingest::sources::vt::parser::{
    compare_designators, inline_section_cross_references, normalize_designator, normalize_text,
    normalize_text_for_comparison, parse_fullchapter_detail, parse_title_index, parse_title_links,
    resolve_and_normalize_url,
};
use std::cmp::Ordering;

#[test]
fn parses_title_links_from_statutes_landing() {
    let html = load_fixture("vt/statutes.html");
    let titles = parse_title_links(&html, "https://legislature.vermont.gov/statutes/")
        .expect("title links should parse");

    assert_eq!(titles.len(), 3);
    assert_eq!(titles[0].title_num, "02");
    assert_eq!(titles[1].title_num, "03APPENDIX");
    assert_eq!(titles[2].title_num, "09A");
}

#[test]
fn parses_title_index_and_chapter_links() {
    let html = load_fixture("vt/title_02.html");
    let parsed = parse_title_index(&html, "https://legislature.vermont.gov/statutes/title/02")
        .expect("title index should parse");

    assert_eq!(parsed.title_num, "02");
    assert_eq!(parsed.title_name, "Legislature");
    assert_eq!(parsed.chapters.len(), 2);
    assert_eq!(parsed.chapters[0].chapter_num, "001");
    assert_eq!(parsed.chapters[0].chapter_display_num, "1");
    assert_eq!(
        parsed.chapters[0].fullchapter_url,
        "https://legislature.vermont.gov/statutes/fullchapter/02/001"
    );
}

#[test]
fn parses_fullchapter_sections_and_routes_history() {
    let html = load_fixture("vt/fullchapter_02_001.html");
    let parsed = parse_fullchapter_detail(&html, "2", "1").expect("fullchapter should parse");

    assert_eq!(parsed.title_name, "Legislature");
    assert_eq!(parsed.chapter_name, "General Assembly");
    assert_eq!(parsed.sections.len(), 3);
    assert_eq!(parsed.sections[0].section_num, "1");
    assert_eq!(parsed.sections[0].section_name, "Place of holding sessions");
    assert!(parsed.sections[0].body.contains("held in Montpelier"));
    assert!(parsed.sections[0]
        .history
        .as_deref()
        .expect("history should exist")
        .contains("Added 2015"));
    assert_eq!(
        parsed.sections[2].body,
        "Repealed. 1979, No. 200 (Adj. Sess.), § 120."
    );
}

#[test]
fn preserves_bold_markers_from_source_content() {
    let html = r#"
<html>
  <body>
    <h2>Title 2 : Legislature.</h2>
    <h3>Chapter 1 : General Assembly.</h3>
    <p><b>§ 1. Sample section.</b></p>
    <p><b>(a)</b> The legislature shall meet.</p>
  </body>
</html>
"#;
    let parsed = parse_fullchapter_detail(html, "2", "1").expect("fullchapter should parse");
    assert_eq!(parsed.sections.len(), 1);
    assert!(parsed.sections[0].body.contains("**(a)**"));
}

#[test]
fn compares_designators_deterministically() {
    assert_eq!(compare_designators("02", "2"), Ordering::Equal);
    assert_eq!(compare_designators("9", "9A"), Ordering::Less);
    assert_eq!(compare_designators("2451", "2451a"), Ordering::Less);
}

#[test]
fn normalizes_designators_for_slugs() {
    assert_eq!(normalize_designator(" 03APPENDIX "), "03appendix");
    assert_eq!(normalize_designator("2451a"), "2451a");
    assert_eq!(normalize_designator("2451(a)"), "2451-a");
}

#[test]
fn rejects_non_statutes_urls() {
    let resolved = resolve_and_normalize_url(
        "https://legislature.vermont.gov/statutes/",
        "https://example.com/statutes/title/02",
    );
    assert!(resolved.is_err());
}

#[test]
fn inlines_simple_section_cross_references() {
    let text = "See section 2 and § 5 for related provisions.";
    let inlined = inline_section_cross_references(text, "02", "001");
    assert!(inlined.contains("[2](/statutes/section/02/001/2)"));
    assert!(inlined.contains("[5](/statutes/section/02/001/5)"));
}

#[test]
fn baseline_text_comparison_for_medium_fullchapter_fixture() {
    let html = load_fixture("vt/fullchapter_09_063_medium.html");
    let parsed = parse_fullchapter_detail(&html, "9", "63").expect("fullchapter should parse");
    for target in &parsed.sections {
        let parser_concatenated = normalize_text_for_comparison(&format!(
            "{} {} {}",
            target.section_name,
            target.body,
            target.history.clone().unwrap_or_default()
        ));
        let baseline_concatenated = normalize_text_for_comparison(&baseline_extract_section_text(
            &html,
            &target.section_num,
        ));
        let expected = normalize_text_for_comparison(&strip_heading_noise(&baseline_concatenated));
        let actual = normalize_text_for_comparison(&strip_heading_noise(&parser_concatenated));

        if expected != actual {
            let mismatch = first_mismatch_index(&expected, &actual);
            panic!(
                "section={} mismatch_at={} expected='{}' actual='{}'",
                target.section_num,
                mismatch,
                excerpt_at(&expected, mismatch),
                excerpt_at(&actual, mismatch)
            );
        }
    }
}

#[test]
fn parses_ucc_and_interstate_compact_style_content() {
    let html_ucc = load_fixture("vt/fullchapter_09_063_medium.html");
    let parsed_ucc =
        parse_fullchapter_detail(&html_ucc, "9A", "63").expect("UCC chapter should parse");
    assert!(parsed_ucc
        .sections
        .iter()
        .any(|section| section.section_num == "2451a"));

    let html_compact = r#"
<html>
  <body>
    <h2>Title 3 : Executive.</h2>
    <h3>Chapter 151 : Interstate Compact on Adult Offender Supervision.</h3>
    <p><b>§ 9911. Purpose.</b></p>
    <p><b>(a)</b> Vermont participates in the interstate compact.</p>
    <p>Added 2014, No. 99, § 2.</p>
  </body>
</html>
"#;
    let parsed_compact =
        parse_fullchapter_detail(html_compact, "3", "151").expect("compact chapter should parse");
    assert_eq!(parsed_compact.sections.len(), 1);
    assert_eq!(parsed_compact.sections[0].section_num, "9911");
    assert!(parsed_compact.sections[0].body.contains("**(a)**"));
}

fn baseline_extract_section_text(html: &str, section_num: &str) -> String {
    let dom = tl::parse(html, tl::ParserOptions::default()).expect("fixture HTML should parse");
    let parser = dom.parser();
    let mut in_target = false;
    let mut parts: Vec<String> = Vec::new();
    let section_heading_re = regex::Regex::new(r"^§\s*([A-Za-z0-9.\-]+)\.")
        .expect("section heading regex should compile");

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        let tag_name = tag.name().as_utf8_str().to_string();
        if tag_name != "p" && tag_name != "b" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        if let Some(captures) = section_heading_re.captures(&text) {
            let current_section = captures[1].to_ascii_lowercase();
            let target = section_num.to_ascii_lowercase();
            if current_section != target {
                if in_target {
                    break;
                }
                continue;
            }
            if !in_target {
                in_target = true;
                parts.push(text);
            }
            continue;
        }
        if in_target && !text.is_empty() {
            parts.push(text);
        }
    }

    parts.join(" ")
}

fn strip_heading_noise(text: &str) -> String {
    let section_heading_re = regex::Regex::new(r"^\s*§+\s*[A-Za-z0-9.\-]+\.\s*")
        .expect("section heading regex should compile");
    section_heading_re.replace(text, "").to_string()
}

fn first_mismatch_index(expected: &str, actual: &str) -> usize {
    let mut i = 0;
    for (a, b) in expected.bytes().zip(actual.bytes()) {
        if a != b {
            return i;
        }
        i += 1;
    }
    i
}

fn excerpt_at(value: &str, index: usize) -> String {
    let start = index.saturating_sub(40);
    let end = (index + 40).min(value.len());
    value[start..end].to_string()
}
