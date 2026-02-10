use usc_ingest::xmlspec::Engine;

usc_ingest::xmlspec! {
    schema DemoSchema {
        record SectionData
        from tag("section")
        where not(ancestor("note")) and parent("doc")
        {
            heading: first_text(desc("heading")),
            num: first_text(child("num")),
            notes: all_text(desc("note")),
            kind: attr("kind"),
        }

        record NoteData
        from tag("note")
        {
            body: first_text(desc("p")),
            role: attr("role"),
        }

        record SectionSummary
        from tag("section")
        where true
        {
            num: first_text(child("num")),
            kind: attr("kind"),
        }
    }
}

mod guard_schema {
    usc_ingest::xmlspec! {
        schema GuardSchema {
            record ParentOrAncestorSection
            from tag("section")
            where parent("doc") or ancestor("container")
            {
                num: first_text(child("num")),
                kind: attr("kind"),
            }

            record StrictParentSection
            from tag("section")
            where parent("doc") and not(ancestor("skip"))
            {
                num: first_text(child("num")),
            }
        }
    }
}

mod deep_guard_schema {
    usc_ingest::xmlspec! {
        schema DeepGuardSchema {
            record DeepSection
            from tag("section")
            where ((not(ancestor("skip")) and (parent("doc") or ancestor("container"))) or (ancestor("outer") and not(parent("skip"))))
            {
                num: first_text(child("num")),
            }
        }
    }
}

#[test]
fn macro_schema_extracts_multiple_record_types() {
    let xml = r#"
        <doc>
            <section kind="public">
                <num>7</num>
                <heading>Main heading</heading>
                <note role="amendments"><p>Amendment text</p></note>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<DemoSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    assert_eq!(out.len(), 3);
    let note = out.iter().find_map(|record| match record {
        DemoSchemaOutput::NoteData(note) => Some(note),
        _ => None,
    });
    let section = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionData(section) => Some(section),
        _ => None,
    });
    let summary = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionSummary(summary) => Some(summary),
        _ => None,
    });

    assert_eq!(
        note,
        Some(&NoteData {
            body: Some("Amendment text".to_string()),
            role: Some("amendments".to_string()),
        })
    );
    assert_eq!(
        section,
        Some(&SectionData {
            heading: Some("Main heading".to_string()),
            num: Some("7".to_string()),
            notes: vec!["Amendment text".to_string()],
            kind: Some("public".to_string()),
        })
    );
    assert_eq!(
        summary,
        Some(&SectionSummary {
            num: Some("7".to_string()),
            kind: Some("public".to_string()),
        })
    );
}

#[test]
fn guard_expression_blocks_non_matching_parent_path() {
    let xml = r#"
        <doc>
            <container>
                <section kind="ignored">
                    <num>1</num>
                    <heading>Wrong parent</heading>
                </section>
            </container>
            <section kind="kept">
                <num>2</num>
                <heading>Right parent</heading>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<DemoSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let sections = out
        .iter()
        .filter_map(|item| match item {
            DemoSchemaOutput::SectionData(data) => Some(data),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].num.as_deref(), Some("2"));
}

#[test]
fn child_selector_ignores_nested_match_but_desc_captures_nested_note_text() {
    let xml = r#"
        <doc>
            <section kind="public">
                <num>10</num>
                <p><num>999</num></p>
                <note><p>alpha</p></note>
                <note><p>beta</p></note>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<DemoSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let section = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionData(section) => Some(section),
        _ => None,
    });
    assert_eq!(
        section,
        Some(&SectionData {
            heading: None,
            num: Some("10".to_string()),
            notes: vec!["alpha".to_string(), "beta".to_string()],
            kind: Some("public".to_string()),
        })
    );
}

#[test]
fn attr_missing_and_empty_tag_behave_as_expected() {
    let xml = r#"
        <doc>
            <note />
            <note role="editorial" />
            <section>
                <num>12</num>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<DemoSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let notes = out
        .iter()
        .filter_map(|record| match record {
            DemoSchemaOutput::NoteData(note) => Some(note),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0].body, None);
    assert_eq!(notes[0].role, None);
    assert_eq!(notes[1].body, None);
    assert_eq!(notes[1].role.as_deref(), Some("editorial"));

    let section = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionData(section) => Some(section),
        _ => None,
    });
    assert_eq!(section.and_then(|s| s.kind.clone()), None);
}

#[test]
fn guard_precedence_and_boolean_composition_are_honored() {
    let xml = r#"
        <doc>
            <section kind="root">
                <num>1</num>
            </section>
            <skip>
                <section kind="blocked">
                    <num>2</num>
                </section>
            </skip>
            <container>
                <section kind="container">
                    <num>3</num>
                </section>
            </container>
        </doc>
    "#;

    let mut engine = Engine::<guard_schema::GuardSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let parent_or_ancestor = out
        .iter()
        .filter_map(|record| match record {
            guard_schema::GuardSchemaOutput::ParentOrAncestorSection(section) => Some(section),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        parent_or_ancestor
            .iter()
            .map(|s| s.num.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["1", "3"]
    );

    let strict_parent = out
        .iter()
        .filter_map(|record| match record {
            guard_schema::GuardSchemaOutput::StrictParentSection(section) => Some(section),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(strict_parent.len(), 1);
    assert_eq!(strict_parent[0].num.as_deref(), Some("1"));
}

#[test]
fn first_text_combines_text_and_cdata_chunks() {
    let xml = r#"
        <doc>
            <section kind="mixed">
                <num>44</num>
                <heading>First <![CDATA[Second]]> Third</heading>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<DemoSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let section = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionData(section) => Some(section),
        _ => None,
    });
    assert_eq!(
        section.and_then(|s| s.heading.clone()),
        Some("First Second Third".to_string())
    );
}

#[test]
fn deeply_nested_guard_parentheses_work() {
    let xml = r#"
        <doc>
            <section><num>1</num></section>
            <skip><section><num>2</num></section></skip>
            <container><section><num>3</num></section></container>
            <outer><inner><section><num>4</num></section></inner></outer>
        </doc>
    "#;

    let mut engine = Engine::<deep_guard_schema::DeepGuardSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let nums = out
        .iter()
        .filter_map(|record| match record {
            deep_guard_schema::DeepGuardSchemaOutput::DeepSection(section) => {
                section.num.as_deref()
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(nums, vec!["1", "3", "4"]);
}

#[test]
fn parent_guard_does_not_skip_unknown_wrappers() {
    let xml = r#"
        <doc>
            <unknown-wrapper>
                <section kind="through-unknown">
                    <num>9</num>
                </section>
            </unknown-wrapper>
        </doc>
    "#;

    let mut engine = Engine::<DemoSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let section = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionData(section) => Some(section),
        _ => None,
    });
    assert_eq!(section.and_then(|s| s.num.clone()), None);
}
