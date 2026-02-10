use usc_ingest::xmlspec::{
    AllTextReducer, AttrReducer, EndEvent, Engine, EngineView, FirstTextReducer, Guard, RootSpec,
    Schema, StartEvent,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TestTag {
    Doc,
    Section,
    Note,
    Heading,
    Num,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SectionRecord {
    heading: Option<String>,
    num: Option<String>,
    notes: Vec<String>,
    kind: Option<String>,
}

#[derive(Debug, Clone)]
struct SectionScope {
    heading: FirstTextReducer,
    num: FirstTextReducer,
    notes: AllTextReducer,
    kind: AttrReducer,
}

struct TestSchema;

impl Schema for TestSchema {
    type Tag = TestTag;
    type Scope = SectionScope;
    type Output = SectionRecord;

    fn tag_count() -> usize {
        5
    }

    fn tag_index(tag: Self::Tag) -> usize {
        match tag {
            TestTag::Doc => 0,
            TestTag::Section => 1,
            TestTag::Note => 2,
            TestTag::Heading => 3,
            TestTag::Num => 4,
        }
    }

    fn intern(bytes: &[u8]) -> Option<Self::Tag> {
        match bytes {
            b"doc" => Some(TestTag::Doc),
            b"section" => Some(TestTag::Section),
            b"note" => Some(TestTag::Note),
            b"heading" => Some(TestTag::Heading),
            b"num" => Some(TestTag::Num),
            _ => None,
        }
    }

    fn roots() -> Vec<RootSpec<Self::Tag>> {
        vec![RootSpec {
            tag: TestTag::Section,
            guard: Guard::Not(Box::new(Guard::Ancestor(TestTag::Note))),
            scope_kind: 0,
        }]
    }

    fn matches_root(
        root: &RootSpec<Self::Tag>,
        start: &quick_xml::events::BytesStart<'_>,
        view: &EngineView<'_, Self::Tag>,
    ) -> bool {
        let _ = start;
        usc_ingest::xmlspec::evaluate_guard(&root.guard, view)
    }

    fn open_scope(
        _scope_kind: u16,
        _root: Self::Tag,
        start: &quick_xml::events::BytesStart<'_>,
        _view: &EngineView<'_, Self::Tag>,
    ) -> Self::Scope {
        let mut kind = AttrReducer::new(b"kind");
        kind.capture(start);

        SectionScope {
            heading: FirstTextReducer::new(),
            num: FirstTextReducer::new(),
            notes: AllTextReducer::new(),
            kind,
        }
    }

    fn on_start(
        scope: &mut Self::Scope,
        event: StartEvent<'_, Self::Tag>,
        view: &EngineView<'_, Self::Tag>,
    ) {
        let is_heading_child =
            event.tag == TestTag::Heading && view.parent_of_depth(TestTag::Section, event.depth);
        let is_num_child =
            event.tag == TestTag::Num && view.parent_of_depth(TestTag::Section, event.depth);
        let is_note_desc =
            event.tag == TestTag::Note && view.ancestor_of_depth(TestTag::Section, event.depth);

        scope.heading.on_start(is_heading_child, event.depth);
        scope.num.on_start(is_num_child, event.depth);
        scope.notes.on_start(is_note_desc, event.depth);
    }

    fn on_text(scope: &mut Self::Scope, text: &[u8]) {
        scope.heading.on_text(text);
        scope.num.on_text(text);
        scope.notes.on_text(text);
    }

    fn on_end(
        scope: &mut Self::Scope,
        event: EndEvent<Self::Tag>,
        _view: &EngineView<'_, Self::Tag>,
    ) {
        scope.heading.on_end(event.depth);
        scope.num.on_end(event.depth);
        scope.notes.on_end(event.depth);
    }

    fn close_scope(scope: Self::Scope) -> Option<Self::Output> {
        Some(SectionRecord {
            heading: scope.heading.take(),
            num: scope.num.take(),
            notes: scope.notes.take(),
            kind: scope.kind.take(),
        })
    }
}

#[test]
fn extracts_first_all_and_attr_reducers() {
    let xml = r#"
        <doc>
            <section kind="public">
                <num>1</num>
                <heading>General <![CDATA[Provisions]]></heading>
                <note>Note A</note>
                <note>Note B</note>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<TestSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    assert_eq!(out.len(), 1);
    assert_eq!(
        out[0],
        SectionRecord {
            heading: Some("General Provisions".to_string()),
            num: Some("1".to_string()),
            notes: vec!["Note A".to_string(), "Note B".to_string()],
            kind: Some("public".to_string()),
        }
    );
}

#[test]
fn guard_blocks_sections_nested_in_notes() {
    let xml = r#"
        <doc>
            <note>
                <section kind="ignored">
                    <num>3</num>
                </section>
            </note>
            <section kind="live">
                <num>4</num>
            </section>
        </doc>
    "#;

    let mut engine = Engine::<TestSchema>::new();
    let mut out = Vec::new();
    engine
        .parse_str(xml, |record| out.push(record))
        .expect("xml should parse");

    assert_eq!(out.len(), 1);
    assert_eq!(out[0].num.as_deref(), Some("4"));
    assert_eq!(out[0].kind.as_deref(), Some("live"));
}

#[test]
fn first_text_waits_for_end_of_selected_element() {
    let mut reducer = FirstTextReducer::new();
    reducer.on_start(true, 2);
    reducer.on_text(b"alpha ");
    reducer.on_start(true, 3);
    reducer.on_text(b"beta");
    reducer.on_end(3);
    reducer.on_end(2);

    assert_eq!(reducer.take().as_deref(), Some("alpha beta"));
}
