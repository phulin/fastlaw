use ingest::sources::uspl::markdown::law_to_markdown;
use ingest::sources::uspl::parser::{parse_uslm_volume, Block, Inline, ParsedLaw};

fn parse_single(xml: &str) -> Option<ParsedLaw> {
    let mut laws = Vec::new();
    parse_uslm_volume(xml, |law| laws.push(law));
    laws.into_iter().next()
}

fn wrap_law(meta: &str, main: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<statutesAtLarge xmlns="http://xml.house.gov/schemas/uslm/1.0">
  <collection>
    <component role="statutesPart">
      <publicLaws>
        <component>
          <pLaw>
            <meta>
              <publicPrivate>Public</publicPrivate>
              <congress>113</congress>
              <docNumber>5</docNumber>
              {meta}
            </meta>
            <main>{main}</main>
          </pLaw>
        </component>
      </publicLaws>
    </component>
  </collection>
</statutesAtLarge>"#
    )
}

// ── Parser: metadata extraction ───────────────────────────────────────────────

#[test]
fn extracts_public_law_number() {
    let xml = wrap_law("", "");
    let law = parse_single(&xml).expect("should yield a law");
    assert_eq!(law.public_law_number, "113-5");
}

#[test]
fn extracts_congress() {
    let xml = wrap_law("", "");
    let law = parse_single(&xml).expect("should yield a law");
    assert_eq!(law.congress, 113);
}

#[test]
fn extracts_stat_citation() {
    let xml = wrap_law(
        r#"<citableAs>Public Law 113-5</citableAs>
           <citableAs>127 Stat. 161</citableAs>"#,
        "",
    );
    let law = parse_single(&xml).expect("should yield a law");
    assert_eq!(law.stat_citation, "127 Stat. 161");
}

#[test]
fn extracts_approved_date() {
    let xml = wrap_law(r#"<approvedDate>March 6, 2013</approvedDate>"#, "");
    let law = parse_single(&xml).expect("should yield a law");
    assert_eq!(law.approved_date, "March 6, 2013");
}

#[test]
fn skips_private_laws() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<statutesAtLarge xmlns="http://xml.house.gov/schemas/uslm/1.0">
  <pLaw>
    <meta>
      <publicPrivate>Private</publicPrivate>
      <congress>113</congress>
      <docNumber>1</docNumber>
    </meta>
    <main/>
  </pLaw>
</statutesAtLarge>"#;
    let mut laws = Vec::new();
    parse_uslm_volume(xml, |law| laws.push(law));
    assert!(laws.is_empty(), "private laws should be skipped");
}

#[test]
fn multiple_laws_in_volume() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<statutesAtLarge xmlns="http://xml.house.gov/schemas/uslm/1.0">
  <pLaw>
    <meta>
      <publicPrivate>Public</publicPrivate>
      <congress>113</congress>
      <docNumber>1</docNumber>
    </meta>
    <main/>
  </pLaw>
  <pLaw>
    <meta>
      <publicPrivate>Public</publicPrivate>
      <congress>113</congress>
      <docNumber>2</docNumber>
    </meta>
    <main/>
  </pLaw>
</statutesAtLarge>"#;
    let mut laws = Vec::new();
    parse_uslm_volume(xml, |law| laws.push(law));
    assert_eq!(laws.len(), 2);
    assert_eq!(laws[0].public_law_number, "113-1");
    assert_eq!(laws[1].public_law_number, "113-2");
}

// ── Parser: content blocks ────────────────────────────────────────────────────

#[test]
fn parses_enacting_formula_as_para() {
    let xml = wrap_law(
        "",
        r#"<enactingFormula>Be it enacted by the Senate and House of Representatives.</enactingFormula>"#,
    );
    let law = parse_single(&xml).expect("law");
    assert!(law.blocks.iter().any(|b| matches!(b, Block::Para(_))));
}

#[test]
fn parses_section_heading() {
    let xml = wrap_law(
        "",
        r#"<section><num>1.</num><heading>Short Title</heading><content>This Act may be cited as the Test Act.</content></section>"#,
    );
    let law = parse_single(&xml).expect("law");
    let heading = law
        .blocks
        .iter()
        .find(|b| matches!(b, Block::Heading { .. }));
    assert!(heading.is_some(), "should have a heading block");
    if let Some(Block::Heading { level, inlines }) = heading {
        assert_eq!(*level, 3);
        let text: String = inlines
            .iter()
            .map(|i| match i {
                Inline::Text(t) => t.as_str(),
                Inline::Link { text, .. } => text.as_str(),
            })
            .collect();
        assert!(text.contains("Short Title"), "heading text: {text}");
    }
}

#[test]
fn parses_subsection_as_outline() {
    // Subsection at top level (not nested inside section) becomes an Outline block.
    let xml = wrap_law(
        "",
        r#"<subsection><num>(a)</num><content>General rule.</content></subsection>"#,
    );
    let law = parse_single(&xml).expect("law");
    let outline = law
        .blocks
        .iter()
        .find(|b| matches!(b, Block::Outline { .. }));
    assert!(outline.is_some(), "should have an outline block");
    if let Some(Block::Outline { marker, .. }) = outline {
        assert_eq!(marker, "(a)");
    }
}

#[test]
fn parses_action_block() {
    let xml = wrap_law(
        "",
        r#"<action><actionDescription>Approved</actionDescription> March 6, 2013.</action>"#,
    );
    let law = parse_single(&xml).expect("law");
    assert!(law.blocks.iter().any(|b| matches!(b, Block::Action(_))));
}

#[test]
fn converts_usc_ref_to_link() {
    let xml = wrap_law(
        "",
        r#"<section><content>See <ref href="/us/usc/t5/s552">5 U.S.C. 552</ref>.</content></section>"#,
    );
    let law = parse_single(&xml).expect("law");
    let has_link = law.blocks.iter().any(|b| {
        let inlines = match b {
            Block::Para(i)
            | Block::Heading { inlines: i, .. }
            | Block::Outline { inlines: i, .. }
            | Block::Action(i) => i,
            Block::Quoted(_) => return false,
        };
        inlines
            .iter()
            .any(|i| matches!(i, Inline::Link { href, .. } if href == "/usc/title-5/section-552"))
    });
    assert!(has_link, "should convert USC href to internal link");
}

#[test]
fn non_usc_ref_becomes_text() {
    let xml = wrap_law(
        "",
        r#"<section><content>See <ref href="/us/stat/127/161">127 Stat. 161</ref>.</content></section>"#,
    );
    let law = parse_single(&xml).expect("law");
    let has_any_link = law.blocks.iter().any(|b| {
        let inlines = match b {
            Block::Para(i)
            | Block::Heading { inlines: i, .. }
            | Block::Outline { inlines: i, .. }
            | Block::Action(i) => i,
            Block::Quoted(_) => return false,
        };
        inlines.iter().any(|i| matches!(i, Inline::Link { .. }))
    });
    assert!(!has_any_link, "non-USC refs should not become links");
}

#[test]
fn skips_legislative_history() {
    let xml = wrap_law(
        "",
        r#"<section><content>Good content.</content></section>
           <legislativeHistory><p>This should be ignored.</p></legislativeHistory>"#,
    );
    let law = parse_single(&xml).expect("law");
    let all_text: String = law
        .blocks
        .iter()
        .flat_map(|b| match b {
            Block::Para(i)
            | Block::Heading { inlines: i, .. }
            | Block::Outline { inlines: i, .. }
            | Block::Action(i) => i
                .iter()
                .map(|inline| match inline {
                    Inline::Text(t) => t.clone(),
                    Inline::Link { text, .. } => text.clone(),
                })
                .collect::<Vec<_>>(),
            Block::Quoted(_) => vec![],
        })
        .collect();
    assert!(
        !all_text.contains("This should be ignored"),
        "legislativeHistory should be skipped"
    );
}

// ── Markdown rendering ────────────────────────────────────────────────────────

#[test]
fn renders_para_as_plain_text() {
    let xml = wrap_law("", r#"<enactingFormula>Be it enacted.</enactingFormula>"#);
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    assert!(md.contains("Be it enacted."), "md: {md}");
}

#[test]
fn renders_heading_level_3() {
    let xml = wrap_law("", r#"<section><heading>My Section</heading></section>"#);
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    assert!(md.contains("### My Section"), "md: {md}");
}

#[test]
fn renders_outline_with_bold_marker() {
    let xml = wrap_law(
        "",
        r#"<subsection><num>(a)</num><content>First item.</content></subsection>"#,
    );
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    assert!(md.contains("**(a)**"), "md: {md}");
    assert!(md.contains("First item."), "md: {md}");
}

#[test]
fn renders_action_in_italics() {
    let xml = wrap_law(
        "",
        r#"<action><actionDescription>Approved March 6, 2013.</actionDescription></action>"#,
    );
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    assert!(md.contains("*Approved March 6, 2013.*"), "md: {md}");
}

#[test]
fn appends_approved_date_if_not_already_in_content() {
    let xml = wrap_law(r#"<approvedDate>March 6, 2013</approvedDate>"#, "");
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    assert!(md.contains("*Approved March 6, 2013.*"), "md: {md}");
}

#[test]
fn does_not_duplicate_approved_date() {
    let xml = wrap_law(
        r#"<approvedDate>March 6, 2013</approvedDate>"#,
        r#"<action><actionDescription>Approved March 6, 2013.</actionDescription></action>"#,
    );
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    let count = md.matches("March 6, 2013").count();
    assert_eq!(count, 1, "date should appear only once: {md}");
}

#[test]
fn renders_usc_link_in_markdown() {
    let xml = wrap_law(
        "",
        r#"<section><content>See <ref href="/us/usc/t5/s552">5 U.S.C. 552</ref>.</content></section>"#,
    );
    let law = parse_single(&xml).expect("law");
    let md = law_to_markdown(&law);
    assert!(
        md.contains("[5 U.S.C. 552](/usc/title-5/section-552)"),
        "md: {md}"
    );
}

// ── VolumeMetadata ────────────────────────────────────────────────────────────

#[test]
fn volume_metadata_parses_pipe_delimited() {
    use ingest::sources::uspl::discover::VolumeMetadata;
    let title_num = "STATUTE-113-1|1|113|1|2013-01-01|2025-09-22T00:00:00Z";
    let meta = VolumeMetadata::parse(title_num).expect("should parse");
    assert_eq!(meta.package_id, "STATUTE-113-1");
    assert_eq!(meta.volume, 1);
    assert_eq!(meta.congress, 113);
    assert_eq!(meta.session, 1);
    assert_eq!(meta.date_issued, "2013-01-01");
    assert_eq!(meta.last_modified, "2025-09-22T00:00:00Z");
}

#[test]
fn volume_metadata_returns_none_for_too_few_fields() {
    use ingest::sources::uspl::discover::VolumeMetadata;
    let result = VolumeMetadata::parse("only|three|fields");
    assert!(result.is_none());
}
