use ingest::xml_path::{Handler, XmlPathFilter};
use quick_xml::events::{BytesEnd, BytesStart, Event};

// Mock Context
#[derive(Debug, Default)]
struct MockContext {
    events: Vec<String>,
}

// Helpers that own their data to match 'static requirement or just conform to Event lifecycle
// quick_xml Event::Start takes BytesStart<'a>.
// We can construct them with owned data.

fn mock_event_start(name: &str) -> Event<'static> {
    // BytesStart::from_content(name, name.len()) is closest but complex.
    // Easier to just use Cow::Owned.
    let bs = BytesStart::new(name.to_string());
    Event::Start(bs.into_owned())
}

fn mock_event_end(name: &str) -> Event<'static> {
    let be = BytesEnd::new(name.to_string());
    Event::End(be.into_owned())
}

fn mock_event_text(text: &str) -> Event<'static> {
    use quick_xml::events::BytesText;
    let bt = BytesText::new(text);
    Event::Text(bt.into_owned())
}

#[test]
fn test_linear_path() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter.in_("uscDoc").in_("main").in_("title");

    let handler: Handler<MockContext> = |ctx, event| match event {
        Event::Start(e) => ctx.events.push(format!(
            "Start: {}",
            String::from_utf8_lossy(e.name().as_ref())
        )),
        Event::End(e) => ctx.events.push(format!(
            "End: {}",
            String::from_utf8_lossy(e.name().as_ref())
        )),
        Event::Text(e) => ctx
            .events
            .push(format!("Text: {}", String::from_utf8_lossy(e.as_ref()))),
        _ => {}
    };
    filter.set_handler(handler);

    let mut ctx = MockContext::default();

    // <uscDoc><main><title>Match</title></main></uscDoc>
    filter.handle_event(&mut ctx, &mock_event_start("uscDoc"));
    filter.handle_event(&mut ctx, &mock_event_start("main"));
    filter.handle_event(&mut ctx, &mock_event_start("ignore"));
    filter.handle_event(&mut ctx, &mock_event_end("ignore"));
    filter.handle_event(&mut ctx, &mock_event_start("title")); // Active!
    filter.handle_event(&mut ctx, &mock_event_text("Match"));
    filter.handle_event(&mut ctx, &mock_event_end("title")); // End Active
    filter.handle_event(&mut ctx, &mock_event_end("main"));
    filter.handle_event(&mut ctx, &mock_event_end("uscDoc"));

    // We expect: Start: title, Text: Match, End: title
    // The handler fires for the target node events.
    assert_eq!(ctx.events.len(), 3);
    assert_eq!(ctx.events[0], "Start: title");
    assert_eq!(ctx.events[1], "Text: Match");
    assert_eq!(ctx.events[2], "End: title");
}

#[test]
fn test_maybe_in_skip() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter.in_("root").maybe_in("skippable").in_("target");

    let mut ctx = MockContext::default();
    filter.set_handler(|ctx: &mut MockContext, _| {
        ctx.events.push("hit".to_string());
    });

    // Path 1: Skip 'skippable' -> <root><target>
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("target")); // Active
    filter.handle_event(&mut ctx, &mock_event_end("target"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));

    // Hit Count: Start(target) + End(target) = 2.
    assert_eq!(
        ctx.events.len(),
        2,
        "Expected 2 hits (Start/End of target), got {:?}",
        ctx.events
    );
}

#[test]
fn test_maybe_in_taken() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter.in_("root").maybe_in("skippable").in_("target");

    let mut ctx = MockContext::default();
    filter.set_handler(|ctx: &mut MockContext, _| {
        ctx.events.push("hit".to_string());
    });

    // Path 2: Take 'skippable' -> <root><skippable><target>
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("skippable"));
    filter.handle_event(&mut ctx, &mock_event_start("target")); // Active
    filter.handle_event(&mut ctx, &mock_event_end("target"));
    filter.handle_event(&mut ctx, &mock_event_end("skippable"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));

    assert_eq!(ctx.events.len(), 2);
}

#[test]
fn test_maybe_in_nested_mismatch() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter.in_("root").maybe_in("skippable").in_("target");

    let mut ctx = MockContext::default();
    filter.set_handler(|ctx: &mut MockContext, _| {
        ctx.events.push("hit".to_string());
    });

    // <root><other><target/></other></root>
    // Logic: 'other' is ignored. 'target' is found.
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("other"));
    filter.handle_event(&mut ctx, &mock_event_start("target"));
    filter.handle_event(&mut ctx, &mock_event_end("target"));
    filter.handle_event(&mut ctx, &mock_event_end("other"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));

    // It should match because we ignore 'other' (noise).
    assert_eq!(ctx.events.len(), 2);
}

#[test]
fn test_consecutive_maybe_in() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter
        .in_("root")
        .maybe_in("opt1")
        .maybe_in("opt2")
        .in_("target");

    let mut ctx = MockContext::default();
    filter.set_handler(|ctx: &mut MockContext, _| {
        ctx.events.push("hit".to_string());
    });

    // <root><opt2><target/></opt2></root> (Skip opt1)
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("opt2"));

    filter.handle_event(&mut ctx, &mock_event_start("target"));
    filter.handle_event(&mut ctx, &mock_event_end("target"));
    filter.handle_event(&mut ctx, &mock_event_end("opt2"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert_eq!(ctx.events.len(), 2, "Failed to match skip opt1");

    ctx.events.clear();
    // <root><target/></root> (Skip both)
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("target"));

    filter.handle_event(&mut ctx, &mock_event_end("target"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert_eq!(ctx.events.len(), 2, "Failed to match skip both");
}

#[test]
fn test_sequence_of_optionals() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    // Simulate: Root -> (Optional Title) -> (Optional Chapter) -> Section
    filter
        .in_("root")
        .maybe_in("title")
        .maybe_in("chapter")
        .in_("section");

    let handler: Handler<MockContext> = |ctx, _| {
        ctx.events.push("hit".to_string());
    };
    filter.set_handler(handler);

    let mut ctx = MockContext::default();

    // Case 1: All present <root><title><chapter><section/></chapter></title></root>
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("title"));
    filter.handle_event(&mut ctx, &mock_event_start("chapter"));
    filter.handle_event(&mut ctx, &mock_event_start("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("chapter"));
    filter.handle_event(&mut ctx, &mock_event_end("title"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert_eq!(ctx.events.len(), 2, "Failed case 1: All present");
    ctx.events.clear();

    // Case 2: Skip Chapter <root><title><section/></title></root>
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("title"));
    filter.handle_event(&mut ctx, &mock_event_start("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("title"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert_eq!(ctx.events.len(), 2, "Failed case 2: Skip Chapter");
    ctx.events.clear();

    // Case 3: Skip Title <root><chapter><section/></chapter></root>
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("chapter"));
    filter.handle_event(&mut ctx, &mock_event_start("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("chapter"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert_eq!(ctx.events.len(), 2, "Failed case 3: Skip Title");
    ctx.events.clear();

    // Case 4: Skip Both <root><section/></root>
    filter.handle_event(&mut ctx, &mock_event_start("root"));
    filter.handle_event(&mut ctx, &mock_event_start("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("section")); // Hit
    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert_eq!(ctx.events.len(), 2, "Failed case 4: Skip Both");
}

#[test]
fn test_attribute_binding() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter.in_("root").bind_attr("id").in_("child");

    let mut ctx = MockContext::default();
    // Handler that checks if 'id' was captured in 'root' (index 0)
    filter.set_handler(|_, _| {});

    // <root id="123"><child>Match</child></root>
    let mut start = BytesStart::new("root");
    start.push_attribute(("id", "123"));
    filter.handle_event(&mut ctx, &Event::Start(start.into_owned()));

    // Check extraction immediately after start of root
    let root_matcher = &filter.matchers[0];
    let key: Box<[u8]> = b"id".as_slice().into();
    let val: Box<[u8]> = b"123".as_slice().into();
    assert_eq!(root_matcher.bound_attrs.get(&key), Some(&val));

    let child = BytesStart::new("child");
    filter.handle_event(&mut ctx, &Event::Start(child.into_owned()));
    filter.handle_event(&mut ctx, &mock_event_end("child"));
    filter.handle_event(&mut ctx, &mock_event_end("root"));

    // Check cleanup
    let root_matcher_after = &filter.matchers[0];
    assert!(
        root_matcher_after.bound_attrs.is_empty(),
        "Attributes should be cleared after scope end"
    );
}

#[test]
fn test_helpers() {
    let mut filter = XmlPathFilter::<MockContext>::new();
    filter
        .in_("root")
        .bind_attr("id")
        .maybe_in("opt")
        .in_("child");

    let mut ctx = MockContext::default();
    filter.set_handler(|_, _| {});

    // <root id="1"><opt><child/></opt></root>
    let mut start = BytesStart::new("root");
    start.push_attribute(("id", "1"));
    filter.handle_event(&mut ctx, &Event::Start(start.into_owned()));

    assert!(filter.is_active("root"));
    assert_eq!(filter.get_attribute("root", "id").as_deref(), Some("1"));
    assert!(!filter.is_active("opt"));

    filter.handle_event(&mut ctx, &mock_event_start("opt"));
    assert!(filter.is_active("opt"));

    filter.handle_event(&mut ctx, &mock_event_start("child"));
    assert!(filter.is_active("child"));

    // Check active_matchers iterator
    let active_names: Vec<String> = filter
        .active_matchers()
        .map(|m| String::from_utf8_lossy(m.tag_name()).into_owned())
        .collect();
    assert_eq!(active_names, vec!["root", "opt", "child"]);

    filter.handle_event(&mut ctx, &mock_event_end("child"));
    assert!(!filter.is_active("child"));

    filter.handle_event(&mut ctx, &mock_event_end("opt"));
    assert!(!filter.is_active("opt"));

    filter.handle_event(&mut ctx, &mock_event_end("root"));
    assert!(!filter.is_active("root"));
}
