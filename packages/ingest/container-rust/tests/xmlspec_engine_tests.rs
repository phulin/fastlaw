use usc_ingest::xmlspec::{
    AllTextReducer, AttrReducer, EndEvent, Engine, EngineView, FirstTextReducer, Guard, RootSpec,
    Schema, Selector, StartEvent, TextReducer,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TestTag {
    Doc,
    Section,
    Note,
    Heading,
    Num,
    P,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SectionRecord {
    heading: Option<String>,
    num: Option<String>,
    notes: Vec<String>,
    body: Option<String>,
    kind: Option<String>,
}

#[derive(Debug, Clone)]
struct SectionScope {
    heading: FirstTextReducer<TestTag>,
    num: FirstTextReducer<TestTag>,
    notes: AllTextReducer<TestTag>,
    body: TextReducer<TestTag>,
    kind: AttrReducer,
}

struct TestSchema;

impl Schema for TestSchema {
    type Tag = TestTag;
    type Scope = SectionScope;
    type Output = SectionRecord;

    fn tag_count() -> usize {
        6
    }

    fn tag_index(tag: Self::Tag) -> usize {
        match tag {
            TestTag::Doc => 0,
            TestTag::Section => 1,
            TestTag::Note => 2,
            TestTag::Heading => 3,
            TestTag::Num => 4,
            TestTag::P => 5,
        }
    }

    fn intern(bytes: &[u8]) -> Option<Self::Tag> {
        match bytes {
            b"doc" => Some(TestTag::Doc),
            b"section" => Some(TestTag::Section),
            b"note" => Some(TestTag::Note),
            b"heading" => Some(TestTag::Heading),
            b"num" => Some(TestTag::Num),
            b"p" => Some(TestTag::P),
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

    fn open_scope(
        _scope_kind: u16,
        _root: Self::Tag,
        start: &quick_xml::events::BytesStart<'_>,
        view: &EngineView<'_, Self::Tag>,
    ) -> Self::Scope {
        let root_depth = view.depth() + 1;
        let mut kind = AttrReducer::new(b"kind");
        kind.capture(start);

        SectionScope {
            heading: FirstTextReducer::new(Selector::Desc(TestTag::Heading), root_depth),
            num: FirstTextReducer::new(Selector::Child(TestTag::Num), root_depth),
            notes: AllTextReducer::new(Selector::Desc(TestTag::Note), root_depth),
            body: TextReducer::new(
                Selector::Desc(TestTag::P),
                vec![Selector::Desc(TestTag::Note)],
                root_depth,
            ),
            kind,
        }
    }

    fn on_start(
        scope: &mut Self::Scope,
        event: StartEvent<'_, Self::Tag>,
        _view: &EngineView<'_, Self::Tag>,
    ) {
        scope.heading.on_start(event.tag, event.depth);
        scope.num.on_start(event.tag, event.depth);
        scope.notes.on_start(event.tag, event.depth);
        scope.body.on_start(event.tag, event.depth);
    }

    fn on_text(scope: &mut Self::Scope, text: &[u8]) {
        scope.heading.on_text(text);
        scope.num.on_text(text);
        scope.notes.on_text(text);
        scope.body.on_text(text);
    }

    fn on_end(
        scope: &mut Self::Scope,
        event: EndEvent<Self::Tag>,
        _view: &EngineView<'_, Self::Tag>,
    ) {
        scope.heading.on_end(event.depth);
        scope.num.on_end(event.depth);
        scope.notes.on_end(event.depth);
        scope.body.on_end(event.depth);
    }

    fn close_scope(scope: Self::Scope) -> Option<Self::Output> {
        Some(SectionRecord {
            heading: scope.heading.take(),
            num: scope.num.take(),
            notes: scope.notes.take(),
            body: scope.body.take(),
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
                <p><num>999</num></p>
                <note><p>Note A</p></note>
                <note><p>Note B</p></note>
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
            body: Some("999".to_string()),
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
                    <heading>Should Not Emit</heading>
                </section>
            </note>
            <section kind="live">
                <num>4</num>
                <heading>Should Emit</heading>
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
    assert_eq!(out[0].body.as_deref(), None);
    assert_eq!(out[0].kind.as_deref(), Some("live"));
}

#[test]
fn text_reducer_excludes_nested_selector_text() {
    let mut reducer = TextReducer::new(
        Selector::Desc(TestTag::P),
        vec![Selector::Desc(TestTag::Note)],
        1,
    );

    reducer.on_start(TestTag::P, 2);
    reducer.on_text(b"alpha ");
    reducer.on_start(TestTag::Note, 3);
    reducer.on_text(b"skip");
    reducer.on_end(3);
    reducer.on_text(b" beta");
    reducer.on_end(2);

    assert_eq!(reducer.take().as_deref(), Some("alpha beta"));
}
