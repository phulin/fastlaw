use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;

/// Canonical organizational level hierarchy for USC.
pub const USC_LEVEL_HIERARCHY: &[&str] = &[
    "title",
    "subtitle",
    "part",
    "subpart",
    "chapter",
    "subchapter",
    "division",
    "subdivision",
];

/// Map from level type to its canonical level_index.
pub fn usc_level_index(level_type: &str) -> Option<usize> {
    USC_LEVEL_HIERARCHY.iter().position(|&l| l == level_type)
}

/// Number of levels (used for section level_index).
pub fn section_level_index() -> usize {
    USC_LEVEL_HIERARCHY.len()
}

fn is_usc_level(tag: &str) -> bool {
    USC_LEVEL_HIERARCHY.contains(&tag) && tag != "title"
}

// Prefixes for constructing IDs if missing
const LEVEL_ID_PREFIXES: &[(&str, &str)] = &[
    ("title", "t"),
    ("subtitle", "st"),
    ("chapter", "ch"),
    ("subchapter", "sch"),
    ("part", "pt"),
    ("subpart", "spt"),
    ("division", "d"),
    ("subdivision", "sd"),
];

fn level_id_prefix(level_type: &str) -> &'static str {
    for &(lt, prefix) in LEVEL_ID_PREFIXES {
        if lt == level_type {
            return prefix;
        }
    }
    ""
}

const SECTION_BODY_TAGS: &[&str] = &[
    "chapeau",
    "p",
    "subsection",
    "paragraph",
    "subparagraph",
    "clause",
    "subclause",
    "item",
    "subitem",
];

fn is_section_body_tag(tag: &str) -> bool {
    SECTION_BODY_TAGS.contains(&tag)
}

#[derive(Debug, Clone)]
pub struct USCLevel {
    pub level_type: String,
    pub level_index: usize,
    pub identifier: String,
    pub num: String,
    pub heading: String,
    pub title_num: String,
    pub parent_identifier: Option<String>,
}

#[derive(Debug, Clone)]
pub struct USCSection {
    pub section_key: String,
    pub title_num: String,
    pub section_num: String,
    pub heading: String,
    pub body: String,
    pub source_credit: String,
    pub amendments: String,
    pub note: String,
    pub path: String,
    pub parent_ref: USCParentRef,
}

#[derive(Debug, Clone)]
pub enum USCParentRef {
    Title {
        title_num: String,
    },
    Level {
        level_type: String,
        identifier: String,
    },
}

#[derive(Debug, Clone)]
pub enum USCStreamEvent {
    Level(USCLevel),
    Section(USCSection),
    Title(String),
}

pub struct ParseResult {
    pub sections: Vec<USCSection>,
    pub levels: Vec<USCLevel>,
    pub title_num: String,
    pub title_name: String,
}

// Data structures for the state machine
#[derive(Debug, Clone)]
struct LevelFrame {
    level_type: String,
    identifier: Option<String>, // Can be inferred later
    num: Option<String>,
    heading: Option<String>,
    parent_identifier: Option<String>,
    emitted: bool,
    bracketed_num: bool,
}

struct ParserState {
    // Current hierarchy of levels
    level_stack: Vec<LevelFrame>,

    // Global doc info
    title_num: String,
    title_name: String,

    // Buffers and Flags
    current_text_buffer: String,

    // Capture targets
    binding_heading_level_idx: Option<usize>, // If we are capturing a heading for a level
    binding_num_level_idx: Option<usize>,     // If we are capturing a num for a level

    // Section State
    current_section: Option<SectionBuilder>,

    // Meta / Title State
    in_meta: bool,
    capturing_meta_title: bool,

    // Main Title Heading State
    in_main_title: bool,
    capturing_main_title_heading: bool,

    // Logic for skipping content (e.g. notes within sections that shouldn't be body)
    skip_body_depth: usize,

    // Note State
    current_note: Option<NoteBuilder>,

    // Inline Heading State
    in_inline_heading: bool,
    inline_heading_buffer: String,

    // Title Tracking
    main_title_found: bool,
}

struct SectionBuilder {
    section_num: Option<String>,
    heading: String,
    body_parts: Vec<String>,
    source_credit: String,
    amendments_parts: Vec<String>,
    note_parts: Vec<CitationEntry>,
    bracketed_num: bool,
    parent_ref: USCParentRef,
}

struct NoteBuilder {
    topic: String,
    role: String,
    heading: String,
    paragraphs: Vec<String>,
}

#[derive(Debug, Clone)]
struct CitationEntry {
    heading: String,
    body: String,
}

impl ParserState {
    fn new(file_title: &str) -> Self {
        Self {
            level_stack: Vec::new(),
            title_num: file_title.to_string(),
            title_name: String::new(),
            current_text_buffer: String::new(),
            binding_heading_level_idx: None,
            binding_num_level_idx: None,
            current_section: None,
            in_meta: false,
            capturing_meta_title: false,
            in_main_title: false,
            capturing_main_title_heading: false,
            skip_body_depth: 0,
            current_note: None,
            in_inline_heading: false,
            inline_heading_buffer: String::new(),
            main_title_found: false,
        }
    }

    fn push_level(&mut self, level_type: String, attrs: &HashMap<String, String>) {
        let parent_identifier = if let Some(parent) = self.level_stack.last() {
            parent.identifier.clone()
        } else {
            // Default to title: {title_num}-title
            Some(format!("{}-title", self.title_num))
        };

        let identifier_attr = attrs.get("identifier").cloned();

        let num_from_id = if let Some(ref id) = identifier_attr {
            parse_level_num_from_identifier(id, &level_type)
        } else {
            None
        };

        self.level_stack.push(LevelFrame {
            level_type,
            identifier: None,
            num: num_from_id,
            heading: None,
            parent_identifier,
            emitted: false,
            bracketed_num: false,
        });
    }

    fn ensure_level_identifier(&mut self, idx: usize) {
        let frame = &mut self.level_stack[idx];
        if frame.identifier.is_none() {
            if let Some(ref num) = frame.num {
                frame.identifier = Some(format!(
                    "{}-{}{}",
                    self.title_num,
                    level_id_prefix(&frame.level_type),
                    num
                ));
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Logic
// ------------------------------------------------------------------------------------------------

pub fn parse_usc_xml_stream<F>(xml: &str, file_title: &str, mut on_event: F) -> (String, String)
where
    F: FnMut(USCStreamEvent),
{
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut state = ParserState::new(file_title);
    let mut buf = Vec::new();
    let mut tag_stack: Vec<String> = Vec::new();
    let mut section_counts: HashMap<String, usize> = HashMap::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let qname = e.name();
                let raw_name = String::from_utf8_lossy(qname.as_ref());
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);

                let parent_tag_owned = tag_stack.last().cloned();
                let parent_tag = parent_tag_owned.as_deref();

                handle_start(&mut state, &tag_name, parent_tag, &attrs, &tag_stack);
                tag_stack.push(tag_name);
            }
            Ok(Event::Empty(ref e)) => {
                let qname = e.name();
                let raw_name = String::from_utf8_lossy(qname.as_ref());
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);

                let parent_tag_owned = tag_stack.last().cloned();
                let parent_tag = parent_tag_owned.as_deref();

                handle_start(&mut state, &tag_name, parent_tag, &attrs, &tag_stack);
                // For logic consistency (parent linkage), we push then pop
                tag_stack.push(tag_name.clone());

                // End logic
                let parent_tag_for_end = tag_stack
                    .len()
                    .checked_sub(2)
                    .and_then(|i| tag_stack.get(i))
                    .map(|s| s.as_str());
                handle_end(
                    &mut state,
                    &tag_name,
                    parent_tag_for_end,
                    &mut on_event,
                    &mut section_counts,
                );
                tag_stack.pop();
            }
            Ok(Event::End(ref e)) => {
                let qname = e.name();
                let raw_name = String::from_utf8_lossy(qname.as_ref());
                let tag_name = normalize_tag_name(&raw_name).to_string();

                tag_stack.pop();
                let parent_tag_owned = tag_stack.last().cloned();
                let parent_tag = parent_tag_owned.as_deref();

                handle_end(
                    &mut state,
                    &tag_name,
                    parent_tag,
                    &mut on_event,
                    &mut section_counts,
                );
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    handle_text(&mut state, &text);
                }
            }
            Ok(Event::CData(ref e)) => {
                let text = String::from_utf8_lossy(e.as_ref());
                handle_text(&mut state, &text);
            }
            Ok(Event::Eof) => break,
            _ => {}
        }
        buf.clear();
    }

    // Attempt to determine title if still missing
    let final_title_name = if state.title_name.is_empty() {
        format!("Title {}", state.title_num)
    } else {
        state.title_name
    };

    on_event(USCStreamEvent::Title(final_title_name.clone()));

    (state.title_num, final_title_name)
}

fn handle_start(
    state: &mut ParserState,
    tag_name: &str,
    parent_tag: Option<&str>,
    attrs: &HashMap<String, String>,
    tag_stack: &[String],
) {
    // 1. Meta / Title logic
    if tag_name == "meta" {
        state.in_meta = true;
    }
    if tag_name == "title" && state.in_meta {
        state.capturing_meta_title = true;
        state.current_text_buffer.clear();
    }

    // 2. Main Title logic
    if tag_name == "title" && parent_tag == Some("main") {
        state.in_main_title = true;
    }
    if tag_name == "heading"
        && parent_tag == Some("title")
        && state.in_main_title
        && !state.main_title_found
    {
        state.capturing_main_title_heading = true;
        state.current_text_buffer.clear();
    }

    // 3. Level Logic
    if is_usc_level(tag_name) {
        state.push_level(tag_name.to_string(), attrs);
    }

    if tag_name == "heading"
        && !state.level_stack.is_empty()
        && state.current_section.is_none()
        && state.current_note.is_none()
        && is_parent_level(parent_tag)
    {
        state.binding_heading_level_idx = Some(state.level_stack.len() - 1);
        state.current_text_buffer.clear();
    }

    if tag_name == "num"
        && !state.level_stack.is_empty()
        && state.current_section.is_none()
        && state.current_note.is_none()
        && is_parent_level(parent_tag)
    {
        state.binding_num_level_idx = Some(state.level_stack.len() - 1);
        state.current_text_buffer.clear();
    }

    // 4. Section Logic
    if tag_name == "section" {
        if state.current_note.is_some() || inside_quoted_content(tag_stack) {
            // Ignore nested section
        } else {
            let identifier = attrs.get("identifier").cloned();
            let section_num = if let Some(ref id) = identifier {
                parse_section_from_identifier(id)
            } else {
                None
            };

            let parent_ref = if let Some(frame) = state.level_stack.last() {
                if let Some(ref id) = frame.identifier {
                    USCParentRef::Level {
                        level_type: frame.level_type.clone(),
                        identifier: id.clone(),
                    }
                } else {
                    USCParentRef::Title {
                        title_num: state.title_num.clone(),
                    }
                }
            } else {
                USCParentRef::Title {
                    title_num: state.title_num.clone(),
                }
            };

            state.current_section = Some(SectionBuilder {
                section_num,
                heading: String::new(),
                body_parts: Vec::new(),
                source_credit: String::new(),
                amendments_parts: Vec::new(),
                note_parts: Vec::new(),
                bracketed_num: false,
                parent_ref,
            });
            state.skip_body_depth = 0; // Fix for leaks from previous sections
        }
    }

    if let Some(_) = state.current_section {
        if tag_name == "num" && parent_tag == Some("section") && state.skip_body_depth == 0 {
            state.current_text_buffer.clear();
        }
        if tag_name == "heading" && parent_tag == Some("section") && state.skip_body_depth == 0 {
            state.current_text_buffer.clear();
        }
        if tag_name == "sourceCredit" {
            state.current_text_buffer.clear();
            state.skip_body_depth += 1;
        }

        if tag_name == "note" {
            let topic = attrs
                .get("topic")
                .map(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let role = attrs
                .get("role")
                .map(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            state.current_note = Some(NoteBuilder {
                topic,
                role,
                heading: String::new(),
                paragraphs: Vec::new(),
            });
            state.skip_body_depth += 1;
        }

        if tag_name == "quotedContent" {
            state.skip_body_depth += 1;
        }

        if is_section_body_tag(tag_name) && state.skip_body_depth == 0 {
            // Block splitting logic:
            // If we start a new body tag, we finish the previous block if any.
            // We push whatever is in buffer.
            let text = state.current_text_buffer.trim().to_string();
            if !text.is_empty() {
                if let Some(ref mut section) = state.current_section {
                    section.body_parts.push(text);
                }
                state.current_text_buffer.clear();
            }
        }

        // Inline num in body -> Bold start
        if tag_name == "num" && state.skip_body_depth == 0 && parent_tag != Some("section") {
            state.current_text_buffer.push_str("**");
        }

        // Inline heading in body -> Bold start (track state)
        if tag_name == "heading" && state.skip_body_depth == 0 && parent_tag != Some("section") {
            state.in_inline_heading = true;
            state.inline_heading_buffer.clear();
        }
    }

    // Note internals
    if let Some(_) = state.current_note {
        if tag_name == "heading" {
            state.current_text_buffer.clear();
        }
        if tag_name == "p" {
            state.current_text_buffer.clear();
        }
    }
}

fn handle_end<F>(
    state: &mut ParserState,
    tag_name: &str,
    parent_tag: Option<&str>,
    on_event: &mut F,
    section_counts: &mut HashMap<String, usize>,
) where
    F: FnMut(USCStreamEvent),
{
    // 1. Meta Title End
    if tag_name == "title" && state.in_meta && state.capturing_meta_title {
        let title = state.current_text_buffer.trim().to_string();
        if !title.is_empty() && !state.main_title_found {
            state.title_name = title.clone();
            on_event(USCStreamEvent::Title(title));
        }
        state.capturing_meta_title = false;
    }
    if tag_name == "meta" {
        state.in_meta = false;
    }

    // 2. Main Title Heading End
    if tag_name == "heading" && state.capturing_main_title_heading {
        let title = normalized_whitespace(&state.current_text_buffer);
        if !title.is_empty() {
            state.title_name = title.clone();
            state.main_title_found = true;
            on_event(USCStreamEvent::Title(title));
        }
        state.capturing_main_title_heading = false;
    }
    if tag_name == "title" && state.in_main_title {
        state.in_main_title = false;
    }

    // 3. Level Logic
    if let Some(idx) = state.binding_heading_level_idx {
        if tag_name == "heading" {
            let text = normalized_whitespace(&state.current_text_buffer);
            let frame = &mut state.level_stack[idx];
            let cleaned = if frame.bracketed_num && text.ends_with(']') {
                text[..text.len() - 1].trim().to_string()
            } else {
                text
            };
            frame.heading = Some(cleaned);
            state.binding_heading_level_idx = None;
            try_emit_level(state, idx, on_event);
        }
    }
    if let Some(idx) = state.binding_num_level_idx {
        if tag_name == "num" {
            let text = state.current_text_buffer.trim().to_string();
            let frame = &mut state.level_stack[idx];
            if text.starts_with('[') {
                frame.bracketed_num = true;
            }
            if frame.num.is_none() {
                frame.num = Some(strip_leading_zeros(&text));
            }
            state.binding_num_level_idx = None;
        }
    }

    if is_usc_level(tag_name) {
        if let Some(frame) = state.level_stack.pop() {
            if !frame.emitted {
                if let Some(valid_level) = build_level_from_frame(&frame, &state.title_num) {
                    on_event(USCStreamEvent::Level(valid_level));
                }
            }
        }
    }

    // 4. Section Logic
    if let Some(ref mut section) = state.current_section {
        if tag_name == "num" && parent_tag == Some("section") && state.skip_body_depth == 0 {
            let text = state.current_text_buffer.trim().to_string();
            if text.starts_with('[') {
                section.bracketed_num = true;
            }
            if section.section_num.is_none() && !text.is_empty() {
                section.section_num = Some(strip_leading_zeros(&text));
            }
            state.current_text_buffer.clear();
        }
        if tag_name == "heading" && parent_tag == Some("section") && state.skip_body_depth == 0 {
            let text = normalized_whitespace(&state.current_text_buffer);
            let cleaned = if section.bracketed_num && text.ends_with(']') {
                text[..text.len() - 1].trim().to_string()
            } else {
                text
            };
            section.heading = cleaned;
            state.current_text_buffer.clear();
        }
        if tag_name == "sourceCredit" {
            section.source_credit = normalized_whitespace(&state.current_text_buffer);
            state.skip_body_depth -= 1;
        }

        if is_section_body_tag(tag_name) && state.skip_body_depth == 0 {
            // Block splitting logic: End of body tag -> push block
            let text = state.current_text_buffer.trim().to_string();
            if !text.is_empty() {
                section.body_parts.push(text);
                state.current_text_buffer.clear();
            }
        }

        // Inline num in body -> Bold end
        if tag_name == "num" && state.skip_body_depth == 0 && parent_tag != Some("section") {
            state.current_text_buffer.push_str("**"); // Removed space to match tests
        }

        // Inline heading in body -> Bold end
        if tag_name == "heading" && state.skip_body_depth == 0 && parent_tag != Some("section") {
            let text = normalized_whitespace(&state.inline_heading_buffer);
            state.in_inline_heading = false;
            // Add space if buffer not empty
            if !state.current_text_buffer.is_empty() && !state.current_text_buffer.ends_with(' ') {
                state.current_text_buffer.push(' ');
            }
            state.current_text_buffer.push_str("**");
            state.current_text_buffer.push_str(&text);
            state.current_text_buffer.push_str("** ");
        }

        if tag_name == "quotedContent" {
            state.skip_body_depth -= 1;
        }
    }

    // Note Logic
    if let Some(ref mut note) = state.current_note {
        if tag_name == "heading" {
            note.heading = normalized_whitespace(&state.current_text_buffer);
        }
        if tag_name == "p" {
            let text = normalized_whitespace(&state.current_text_buffer);
            if !text.is_empty() {
                note.paragraphs.push(text);
            }
        }
    }

    if tag_name == "note" {
        if let Some(note) = state.current_note.take() {
            state.skip_body_depth -= 1;
            if let Some(ref mut section) = state.current_section {
                add_note_to_section(section, note);
            }
        }
    }

    if tag_name == "section" {
        if let Some(section_builder) = state.current_section.take() {
            emit_section(section_builder, state, section_counts, on_event);
        }
    }
}

fn handle_text(state: &mut ParserState, text: &str) {
    let normalized = text.replace('\n', " ").replace('\r', " ");
    if state.in_inline_heading {
        state.inline_heading_buffer.push_str(&normalized);
    } else {
        state.current_text_buffer.push_str(&normalized);
    }
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

fn try_emit_level<F>(state: &mut ParserState, idx: usize, on_event: &mut F)
where
    F: FnMut(USCStreamEvent),
{
    state.ensure_level_identifier(idx);
    let frame = &mut state.level_stack[idx];

    if !frame.emitted && frame.identifier.is_some() && frame.num.is_some() {
        let level = USCLevel {
            level_type: frame.level_type.clone(),
            level_index: usc_level_index(&frame.level_type).unwrap_or(0),
            identifier: frame.identifier.clone().unwrap(),
            num: frame.num.clone().unwrap(),
            heading: frame.heading.clone().unwrap_or_default(),
            title_num: state.title_num.clone(),
            parent_identifier: frame.parent_identifier.clone(),
        };
        on_event(USCStreamEvent::Level(level));
        frame.emitted = true;
    }
}

fn build_level_from_frame(frame: &LevelFrame, title_num: &str) -> Option<USCLevel> {
    if let Some(id) = &frame.identifier {
        if let Some(num) = &frame.num {
            return Some(USCLevel {
                level_type: frame.level_type.clone(),
                level_index: usc_level_index(&frame.level_type).unwrap_or(0),
                identifier: id.clone(),
                num: num.clone(),
                heading: frame.heading.clone().unwrap_or_default(),
                title_num: title_num.to_string(),
                parent_identifier: frame.parent_identifier.clone(),
            });
        }
    }
    // Try to recover identifier if num exists
    if frame.identifier.is_none() {
        if let Some(num) = &frame.num {
            let id = format!(
                "{}-{}{}",
                title_num,
                level_id_prefix(&frame.level_type),
                num
            );
            return Some(USCLevel {
                level_type: frame.level_type.clone(),
                level_index: usc_level_index(&frame.level_type).unwrap_or(0),
                identifier: id,
                num: num.clone(),
                heading: frame.heading.clone().unwrap_or_default(),
                title_num: title_num.to_string(),
                parent_identifier: frame.parent_identifier.clone(),
            });
        }
    }
    None
}

fn emit_section<F>(
    mut builder: SectionBuilder,
    state: &mut ParserState,
    counts: &mut HashMap<String, usize>,
    on_event: &mut F,
) where
    F: FnMut(USCStreamEvent),
{
    let section_num = match builder.section_num {
        Some(s) => s,
        None => return,
    };

    let count = counts
        .entry(section_num.clone())
        .and_modify(|c| *c += 1)
        .or_insert(1);
    let final_section_num = if *count == 1 {
        section_num
    } else {
        format!("{}-{}", section_num, count)
    };

    let path = format!(
        "/statutes/usc/section/{}/{}",
        state.title_num, final_section_num
    );

    // Flush remaining buffer
    let last_text = state.current_text_buffer.trim().to_string();
    if !last_text.is_empty() {
        builder.body_parts.push(last_text);
        state.current_text_buffer.clear();
    }

    let body_text = builder.body_parts.join("\n\n");
    let body = normalized_whitespace(&body_text);

    let note = builder
        .note_parts
        .iter()
        .map(|c| {
            if c.heading.is_empty() {
                c.body.clone()
            } else {
                format!("**{}**\n{}", c.heading, c.body)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    on_event(USCStreamEvent::Section(USCSection {
        section_key: format!("{}:{}", state.title_num, final_section_num),
        title_num: state.title_num.clone(),
        section_num: final_section_num,
        heading: builder.heading,
        body,
        source_credit: builder.source_credit,
        amendments: builder.amendments_parts.join("\n\n"),
        note,
        path,
        parent_ref: builder.parent_ref,
    }));
}

fn add_note_to_section(section: &mut SectionBuilder, note: NoteBuilder) {
    let body = normalized_whitespace(&note.paragraphs.join("\n\n"));
    let final_body = if body.is_empty() {
        note.heading.clone()
    } else {
        if note.heading.is_empty() {
            body
        } else {
            format!("**{}**\n{}", note.heading, body)
        }
    };
    let heading_lower = note.heading.to_lowercase();

    if !final_body.is_empty() || !note.topic.is_empty() {
        if note.topic == "amendments" || heading_lower.contains("amendments") {
            if !final_body.is_empty() {
                section.amendments_parts.push(final_body);
            }
        } else if note.role.contains("crossHeading")
            || note.heading.contains("Editorial")
            || note.heading.contains("Statutory")
        {
            // Ignore
        } else if !final_body.is_empty() {
            section.note_parts.push(CitationEntry {
                heading: String::new(), // Already formatted into final_body if needed
                body: final_body,
            });
        }
    }
}

fn is_parent_level(parent: Option<&str>) -> bool {
    parent.map(|p| is_usc_level(p)).unwrap_or(false)
}

fn inside_quoted_content(stack: &[String]) -> bool {
    stack.iter().any(|s| s == "quotedContent")
}

// ------------------------------------------------------------------------------------------------
// String Utils
// ------------------------------------------------------------------------------------------------

fn normalize_tag_name(tag_name: &str) -> &str {
    match tag_name.find(':') {
        Some(idx) => &tag_name[idx + 1..],
        None => tag_name,
    }
}

pub fn strip_leading_zeros(value: &str) -> String {
    let mut chars = value.chars().peekable();
    let mut digits = String::new();
    let mut suffix = String::new();

    let mut saw_nonzero = false;
    let mut all_zeros = true;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            if c != '0' {
                saw_nonzero = true;
                all_zeros = false;
            }
            if saw_nonzero || c != '0' {
                digits.push(c);
            }
            chars.next();
        } else {
            break;
        }
    }

    if digits.is_empty() && all_zeros && value.chars().any(|c| c.is_ascii_digit()) {
        digits.push('0');
    }
    if digits.is_empty() {
        return value.replace('\u{2013}', "-").replace('\u{2014}', "-");
    }

    for c in chars {
        if c.is_ascii_alphabetic() {
            suffix.push(c.to_ascii_lowercase());
        } else {
            return value.replace('\u{2013}', "-").replace('\u{2014}', "-");
        }
    }

    format!("{digits}{suffix}")
        .replace('\u{2013}', "-")
        .replace('\u{2014}', "-")
}

pub fn normalized_whitespace(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    s.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

fn parse_section_from_identifier(ident: &str) -> Option<String> {
    let rest = ident.replace("/us/usc/", "");
    let rest = rest.trim_matches('/');
    for part in rest.split('/') {
        if part.starts_with('s') {
            return Some(strip_leading_zeros(&part[1..]));
        }
    }
    None
}

fn parse_level_num_from_identifier(ident: &str, level_type: &str) -> Option<String> {
    let rest = ident.replace("/us/usc/", "");
    let rest = rest.trim_matches('/');
    let parts: Vec<&str> = rest.split('/').collect();
    let prefix = level_id_prefix(level_type);

    for part in &parts {
        if !part.starts_with(prefix) {
            continue;
        }
        let num_part = &part[prefix.len()..];
        if num_part.is_empty() {
            continue;
        }
        if !num_part
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            continue;
        }

        let mut is_longer_prefix = false;
        for &(other_level, other_prefix) in LEVEL_ID_PREFIXES {
            if other_level != level_type
                && other_prefix.starts_with(prefix)
                && other_prefix.len() > prefix.len()
                && part.starts_with(other_prefix)
            {
                is_longer_prefix = true;
                break;
            }
        }

        if !is_longer_prefix {
            return Some(strip_leading_zeros(num_part));
        }
    }

    None
}

fn extract_attrs(e: &BytesStart) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    for attr in e.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
        let val = String::from_utf8_lossy(&attr.value).to_string();
        attrs.insert(key, val);
    }
    attrs
}

pub fn parse_usc_xml(xml: &str, file_title: &str, _source_url: &str) -> ParseResult {
    let mut sections = Vec::new();
    let mut levels = Vec::new();

    let (title_num, title_name) = parse_usc_xml_stream(xml, file_title, |event| match event {
        USCStreamEvent::Section(s) => sections.push(s),
        USCStreamEvent::Level(l) => levels.push(l),
        USCStreamEvent::Title(_) => {}
    });

    ParseResult {
        sections,
        levels,
        title_num,
        title_name,
    }
}
