use crate::common::load_fixture;
use ingest::sources::rigl::parser::{
    compare_designators, normalize_designator, normalize_text, normalize_text_for_comparison,
    parse_chapter_index, parse_section_detail, parse_title_index, parse_title_links,
};
use std::cmp::Ordering;

#[test]
fn parses_title_links_from_statutes_landing() {
    let html = load_fixture("rigl/statutes.html");
    let titles = parse_title_links(
        &html,
        "https://webserver.rilegislature.gov/statutes/Statutes.html",
    )
    .expect("title links should parse");

    assert!(titles.len() > 40);
    assert_eq!(titles[0].title_num, "1");
    assert_eq!(titles[1].title_num, "2");
    assert!(titles.iter().any(|title| title.title_num == "40.1"));
}

#[test]
fn parses_title_index_and_chapter_links() {
    let html = load_fixture("rigl/title_1_index.htm");
    let parsed = parse_title_index(
        &html,
        "https://webserver.rilegislature.gov/Statutes/TITLE1/INDEX.HTM",
    )
    .expect("title index should parse");

    assert_eq!(parsed.title_num, "1");
    assert_eq!(parsed.title_name, "Aeronautics");
    assert_eq!(parsed.chapters.len(), 8);
    assert_eq!(parsed.chapters[0].chapter_num, "1-1");
    assert_eq!(
        parsed.chapters[0].chapter_name,
        "Airports Division — Aeronautics Advisory Board [Repealed.]"
    );
}

#[test]
fn parses_reserved_chapter_index() {
    let html = load_fixture("rigl/chapter_40.1-8.1_index.htm");
    let parsed = parse_chapter_index(
        &html,
        "https://webserver.rilegislature.gov/Statutes/TITLE40.1/40.1-8.1/INDEX.htm",
    )
    .expect("reserved chapter index should parse");

    assert_eq!(parsed.chapter_num, "40.1-8.1");
    assert_eq!(parsed.chapter_name, "[Reserved.]");
    assert!(parsed.sections.is_empty());
}

#[test]
fn parses_section_and_routes_history_block() {
    let html = load_fixture("rigl/section_1-2-1.htm");
    let parsed = parse_section_detail(&html).expect("section detail should parse");

    assert_eq!(parsed.section_num, "1-2-1");
    assert_eq!(
        parsed.section_name,
        "Powers of the president and CEO of the Rhode Island airport corporation."
    );
    assert!(parsed
        .body
        .contains("**(a)** The president and CEO has supervision"));
    assert!(parsed
        .history
        .as_deref()
        .expect("history must exist")
        .starts_with("P.L. 1935, ch. 2250, § 63"));
}

#[test]
fn preserves_bold_markers_from_source_content() {
    let html = load_fixture("rigl/section_1-2-1.htm");
    let parsed = parse_section_detail(&html).expect("section detail should parse");

    assert!(parsed.body.contains("**(a)**"));
    assert!(parsed.body.contains("**(1)**"));
    assert!(parsed.body.contains("**(2)**"));
}

#[test]
fn compares_designators_deterministically() {
    assert_eq!(compare_designators("40.1", "40.1"), Ordering::Equal);
    assert_eq!(compare_designators("6", "6A"), Ordering::Less);
    assert_eq!(compare_designators("1-2-5", "1-2-14"), Ordering::Less);
}

#[test]
fn normalizes_designators_for_slugs() {
    assert_eq!(normalize_designator(" 40.1-24.6 "), "40.1-24.6");
    assert_eq!(normalize_designator("42-11-5 — 42-11-8"), "42-11-5-42-11-8");
}

#[test]
fn baseline_text_comparison_for_medium_section_fixture() {
    for fixture in [
        "rigl/section_1-2-1.htm",
        "rigl/section_1-2-5.htm",
        "rigl/section_42-11-2.htm",
        "rigl/section_42-11-2.2.htm",
    ] {
        let html = load_fixture(fixture);
        let parsed = parse_section_detail(&html).expect("section detail should parse");
        let parser_concatenated = normalize_text_for_comparison(&format!(
            "{} {} {}",
            parsed.section_name,
            parsed.body,
            parsed.history.clone().unwrap_or_default()
        ));

        let baseline_concatenated =
            normalize_text_for_comparison(&baseline_extract_section_text(&html));
        let expected = normalize_text_for_comparison(&strip_heading_noise(&baseline_concatenated));
        let actual = normalize_text_for_comparison(&strip_heading_noise(&parser_concatenated));

        if expected != actual {
            let mismatch = first_mismatch_index(&expected, &actual);
            panic!(
                "fixture={} section={} mismatch_at={} expected='{}' actual='{}'",
                fixture,
                parsed.section_num,
                mismatch,
                excerpt_at(&expected, mismatch),
                excerpt_at(&actual, mismatch)
            );
        }
    }
}

#[test]
fn captures_history_when_label_omits_period_and_uses_follow_on_paragraphs() {
    let html = r#"
<html>
  <body>
    <h1><center>Title 1<br>Aeronautics</center></h1>
    <h2><center>Chapter 2<br>Airports and Landing Fields</center></h2>
    <p><b>§ 1-2-999. Sample section.</b></p>
    <p>Body paragraph.</p>
    <p>History of Section</p>
    <p>P.L. 2000, ch. 1, § 1.</p>
    <p>P.L. 2001, ch. 2, § 2.</p>
  </body>
</html>
"#;

    let parsed = parse_section_detail(html).expect("section detail should parse");
    assert_eq!(parsed.body, "Body paragraph.");
    assert_eq!(
        parsed.history.as_deref(),
        Some("P.L. 2000, ch. 1, § 1.\n\nP.L. 2001, ch. 2, § 2.")
    );
}

#[test]
fn captures_inline_history_with_colon_separator() {
    let html = r#"
<html>
  <body>
    <h1><center>Title 1<br>Aeronautics</center></h1>
    <h2><center>Chapter 2<br>Airports and Landing Fields</center></h2>
    <p><b>§ 1-2-998. Sample section.</b></p>
    <p>History of Section: P.L. 2002, ch. 3, § 3.</p>
  </body>
</html>
"#;

    let parsed = parse_section_detail(html).expect("section detail should parse");
    assert_eq!(parsed.body, "");
    assert_eq!(parsed.history.as_deref(), Some("P.L. 2002, ch. 3, § 3."));
}

#[test]
fn parses_ucc_and_interstate_compact_style_designators() {
    let html = r#"
<html>
  <body>
    <h1><center>Title 6<br>Commercial Law — General Regulatory Provisions</center></h1>
    <h2><center>Chapter 6A-1<br>Uniform Commercial Code</center></h2>
    <p><b>§ 6A-1-101. Short title.</b></p>
    <p><b>(a)</b> This chapter may be cited as the Uniform Commercial Code.</p>
    <p>History of Section: P.L. 2001, ch. 1, § 1.</p>
  </body>
</html>
"#;
    let parsed = parse_section_detail(html).expect("UCC style section should parse");
    assert_eq!(parsed.title_num, "6");
    assert_eq!(parsed.chapter_num, "6A-1");
    assert_eq!(parsed.section_num, "6A-1-101");
    assert!(parsed.body.contains("**(a)**"));

    let html_compact = r#"
<html>
  <body>
    <h1><center>Title 42<br>State Affairs and Government</center></h1>
    <h2><center>Chapter 42-64.1<br>Interstate Insurance Product Regulation Compact</center></h2>
    <p><b>§ 42-64.1-1. Compact adoption.</b></p>
    <p>The interstate compact is enacted and entered into.</p>
  </body>
</html>
"#;
    let parsed_compact =
        parse_section_detail(html_compact).expect("compact style section should parse");
    assert_eq!(parsed_compact.chapter_num, "42-64.1");
    assert_eq!(parsed_compact.section_num, "42-64.1-1");
}

fn baseline_extract_section_text(html: &str) -> String {
    let dom = tl::parse(html, tl::ParserOptions::default()).expect("fixture HTML should parse");
    let parser = dom.parser();
    let mut parts: Vec<String> = Vec::new();
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "p" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        if text.is_empty() || text.starts_with("R.I. Gen. Laws §") {
            continue;
        }
        parts.push(text);
    }
    parts.join(" ")
}

fn strip_heading_noise(text: &str) -> String {
    let section_heading_re = regex::Regex::new(
        r"^\s*§*\s*\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)+(?:\s*[—-]\s*\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)+)?\.?\s*",
    )
    .expect("section heading regex should compile");
    section_heading_re
        .replace(text, "")
        .to_string()
        .replace("§", "")
        .replace("History of Section.", "")
        .replace('\u{00A0}', " ")
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
