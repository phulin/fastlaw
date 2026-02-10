use usc_ingest::xmlspec::Engine;

usc_ingest::xmlspec! {
    schema DemoSchema {
        record SectionData
        from tag("section")
        where and(not(ancestor(tag("note"))), parent(tag("doc")))
        {
            heading: first_text() where and(tag("heading"), parent(tag("section"))),
            num: first_text() where and(tag("num"), parent(tag("section"))),
            notes: all_text() where tag("note"),
            kind: attr("kind") where tag("section"),
        }

        record NoteData
        from tag("note")
        {
            body: first_text() where tag("p"),
            role: attr("role") where tag("note"),
        }

        record SectionSummary
        from tag("section")
        {
            num: first_text() where and(tag("num"), parent(tag("section"))),
            kind: attr("kind") where tag("section"),
        }

        record SectionNumAttr
        from tag("section")
        {
            num: attr("value") where and(tag("num"), parent(tag("section"))),
        }
    }
}

mod guard_schema {
    usc_ingest::xmlspec! {
        schema GuardSchema {
            record ParentOrAncestorSection
            from tag("section")
            where or(parent(tag("doc")), ancestor(tag("container")))
            {
                num: first_text() where and(tag("num"), parent(tag("section"))),
            }

            record StrictParentSection
            from tag("section")
            where and(parent(tag("doc")), not(ancestor(tag("skip"))))
            {
                num: first_text() where and(tag("num"), parent(tag("section"))),
            }
        }
    }
}

mod note_partition_schema {
    usc_ingest::xmlspec! {
        schema NotePartitionSchema {
            record AmendmentNote
            from tag("note")
            where attr_is("topic", "amendments")
            {
                heading: first_text() where and(tag("heading"), parent(tag("note"))),
                text: all_text() where tag("p"),
            }

            record GeneralNote
            from tag("note")
            where not(attr_is("topic", "amendments"))
            {
                heading: first_text() where and(tag("heading"), parent(tag("note"))),
                text: all_text() where tag("p"),
            }
        }
    }
}

mod fragments_schema {
    usc_ingest::xmlspec! {
        schema FragmentsSchema {
            record Paragraph
            from tag("p")
            {
                body: all_fragments() where tag("p") inline {
                    tag("heading") => Bold,
                    tag("i") => Italic,
                },
            }
        }
    }
}

#[test]
fn macro_schema_extracts_multiple_record_types() {
    let xml = r#"
        <doc>
            <section kind="public">
                <num value="7">7</num>
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
    let num_attr = out.iter().find_map(|record| match record {
        DemoSchemaOutput::SectionNumAttr(data) => Some(data),
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
    assert_eq!(
        num_attr,
        Some(&SectionNumAttr {
            num: Some("7".to_string()),
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
                </section>
            </container>
            <section kind="kept">
                <num>2</num>
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
fn guard_composition_works() {
    let xml = r#"
        <doc>
            <section><num>1</num></section>
            <skip><section><num>2</num></section></skip>
            <container><section><num>3</num></section></container>
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
            guard_schema::GuardSchemaOutput::ParentOrAncestorSection(section) => {
                section.num.as_deref()
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(parent_or_ancestor, vec!["1", "3"]);

    let strict_parent = out
        .iter()
        .filter_map(|record| match record {
            guard_schema::GuardSchemaOutput::StrictParentSection(section) => section.num.as_deref(),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(strict_parent, vec!["1"]);
}

#[test]
fn where_can_partition_records_by_attr_predicate() {
    let xml = r#"
        <doc>
            <note topic="amendments"><heading>History</heading><p>A</p></note>
            <note><heading>Editorial Notes</heading><p>C</p></note>
        </doc>
    "#;

    let mut engine = Engine::<note_partition_schema::NotePartitionSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let amendments = out
        .iter()
        .filter_map(|record| match record {
            note_partition_schema::NotePartitionSchemaOutput::AmendmentNote(note) => {
                Some(note.text.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let general = out
        .iter()
        .filter_map(|record| match record {
            note_partition_schema::NotePartitionSchemaOutput::GeneralNote(note) => {
                Some(note.text.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(amendments, vec![vec!["A".to_string()]]);
    assert_eq!(general, vec![vec!["C".to_string()]]);
}

#[test]
fn all_fragments_emits_inline_variants() {
    let xml = r#"
        <doc>
            <p>abc <heading>xyz</heading> def <i>q</i></p>
        </doc>
    "#;

    let mut engine = Engine::<fragments_schema::FragmentsSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    let paragraph = out.iter().find_map(|record| match record {
        fragments_schema::FragmentsSchemaOutput::Paragraph(p) => Some(p),
    });
    assert_eq!(
        paragraph.map(|p| p.body.clone()),
        Some(vec![
            fragments_schema::ParagraphbodyFragment::Text("abc".to_string()),
            fragments_schema::ParagraphbodyFragment::Bold("xyz".to_string()),
            fragments_schema::ParagraphbodyFragment::Text("def".to_string()),
            fragments_schema::ParagraphbodyFragment::Italic("q".to_string()),
        ])
    );
}
