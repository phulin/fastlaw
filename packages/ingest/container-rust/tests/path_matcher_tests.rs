use quick_xml::events::{BytesEnd, BytesStart, Event};
use usc_ingest::xml_path::{Handler, XmlPathFilter};

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
