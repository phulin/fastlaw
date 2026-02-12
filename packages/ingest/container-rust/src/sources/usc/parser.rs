use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use regex::Regex;
use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::sync::LazyLock;

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static UNICODE_DASH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\u2010-\u2014\u2212]").unwrap());
static MULTI_NEWLINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static LEVEL_SEGMENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?P<prefix>st|sch|spt|sd|ch|pt|t|d)(?P<num>.+)$").unwrap());

#[derive(Debug, Clone)]
pub struct USCParseResult {
    pub title_num: String,
    pub title_name: String,
    pub levels: Vec<USCLevel>,
    pub sections: Vec<USCSection>,
}

#[derive(Debug, Clone)]
pub struct USCLevel {
    pub title_num: String,
    pub level_type: &'static str,
    pub level_index: usize,
    pub identifier: String,
    pub parent_identifier: Option<String>,
    pub num: String,
    pub heading: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub enum USCParentRef {
    Title {
        title_num: String,
    },
    Level {
        identifier: String,
        level_type: &'static str,
    },
}

#[derive(Debug, Clone)]
pub struct USCSection {
    pub title_num: String,
    pub section_num: String,
    pub section_key: String,
    pub heading: String,
    pub body: String,
    pub source_credit: String,
    pub amendments: String,
    pub note: String,
    pub path: String,
    pub parent_ref: USCParentRef,
}

#[derive(Debug, Clone)]
pub enum USCStreamEvent {
    Title(String),
    Level(USCLevel),
    Section(USCSection),
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tag {
    Meta = 0,
    Main = 1,
    Title = 2,
    Subtitle = 3,
    Chapter = 4,
    Subchapter = 5,
    Division = 6,
    Subdivision = 7,
    Part = 8,
    Subpart = 9,
    Section = 10,
    Num = 11,
    Heading = 12,
    Content = 13,
    Paragraph = 14,
    Subsection = 15,
    Subparagraph = 16,
    Clause = 17,
    Subclause = 18,
    Chapeau = 19,
    Item = 20,
    Subitem = 21,
    Continuation = 22,
    SourceCredit = 23,
    Notes = 24,
    Note = 25,
    QuotedContent = 26,
    P = 27,
}

#[inline(always)]
const fn bit(tag: Tag) -> u64 {
    1u64 << (tag as u64)
}

fn level_tag_str(tag: Tag) -> &'static str {
    match tag {
        Tag::Subtitle => "subtitle",
        Tag::Chapter => "chapter",
        Tag::Subchapter => "subchapter",
        Tag::Division => "division",
        Tag::Subdivision => "subdivision",
        Tag::Part => "part",
        Tag::Subpart => "subpart",
        _ => unreachable!(),
    }
}

fn classify(name: &[u8]) -> Option<Tag> {
    match name {
        b"meta" => Some(Tag::Meta),
        b"main" => Some(Tag::Main),
        b"title" => Some(Tag::Title),
        b"subtitle" => Some(Tag::Subtitle),
        b"chapter" => Some(Tag::Chapter),
        b"subchapter" => Some(Tag::Subchapter),
        b"division" => Some(Tag::Division),
        b"subdivision" => Some(Tag::Subdivision),
        b"part" => Some(Tag::Part),
        b"subpart" => Some(Tag::Subpart),
        b"section" => Some(Tag::Section),
        b"num" => Some(Tag::Num),
        b"heading" => Some(Tag::Heading),
        b"content" => Some(Tag::Content),
        b"paragraph" => Some(Tag::Paragraph),
        b"subsection" => Some(Tag::Subsection),
        b"subparagraph" => Some(Tag::Subparagraph),
        b"clause" => Some(Tag::Clause),
        b"subclause" => Some(Tag::Subclause),
        b"chapeau" => Some(Tag::Chapeau),
        b"item" => Some(Tag::Item),
        b"subitem" => Some(Tag::Subitem),
        b"continuation" => Some(Tag::Continuation),
        b"sourceCredit" => Some(Tag::SourceCredit),
        b"notes" => Some(Tag::Notes),
        b"note" => Some(Tag::Note),
        b"quotedContent" => Some(Tag::QuotedContent),
        b"p" => Some(Tag::P),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct NumHeadingCapture {
    num: String,
    heading: String,
}

impl NumHeadingCapture {
    fn with_num(num: String) -> Self {
        Self {
            num,
            heading: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct OpenLevelRef {
    depth: usize,
    level_type: &'static str,
    identifier: String,
    parent_identifier: Option<String>,
    raw_identifier: Option<String>,
    capture: NumHeadingCapture,
}

#[derive(Debug, Clone)]
struct BodyFrame {
    depth: usize,
    text: String,
}

#[derive(Debug, Clone)]
struct ActiveNote {
    depth: usize,
    topic: Option<String>,
    heading: String,
    text: String,
}

#[derive(Debug, Clone)]
struct ActiveSection {
    depth: usize,
    capture: NumHeadingCapture,
    identifier: Option<String>,
    parent_ref: USCParentRef,
    body_frames: Vec<BodyFrame>,
    body_parts: Vec<String>,
    free_text: String,
    source_credit: String,
    amendments: Vec<String>,
    notes: Vec<String>,
    active_notes: Vec<ActiveNote>,
}

impl ActiveSection {
    fn target_text_mut(&mut self) -> &mut String {
        if let Some(frame) = self.body_frames.last_mut() {
            &mut frame.text
        } else {
            &mut self.free_text
        }
    }
}

#[repr(u8)]
#[derive(Clone, Copy)]
enum AttrName {
    Identifier = 0,
    Value = 1,
    Topic = 2,
}

const ATTR_COUNT: usize = 3;

fn classify_attr(name: &[u8]) -> Option<AttrName> {
    match name {
        b"identifier" => Some(AttrName::Identifier),
        b"value" => Some(AttrName::Value),
        b"topic" => Some(AttrName::Topic),
        _ => None,
    }
}

struct Attributes<'a> {
    event: &'a BytesStart<'a>,
    values: OnceCell<[Option<Cow<'a, [u8]>>; ATTR_COUNT]>,
}

impl<'a> Attributes<'a> {
    fn new(event: &'a BytesStart<'a>) -> Self {
        Self {
            event,
            values: OnceCell::new(),
        }
    }

    fn load(&self) -> &[Option<Cow<'a, [u8]>>; ATTR_COUNT] {
        self.values.get_or_init(|| {
            let mut values: [Option<Cow<'a, [u8]>>; ATTR_COUNT] = [None, None, None];
            for attr in self.event.attributes().flatten() {
                if let Some(name) = classify_attr(attr.key.as_ref()) {
                    values[name as usize] = Some(attr.value);
                }
            }
            values
        })
    }

    fn get(&self, name: AttrName) -> Option<String> {
        self.load()[name as usize].as_ref().map(|bytes| {
            std::str::from_utf8(bytes)
                .ok()
                .and_then(|s| quick_xml::escape::unescape(s).ok())
                .map(|cow| cow.into_owned())
                .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
        })
    }
}

struct ParserState {
    title_num: String,
    title_name_main: Option<String>,
    title_name_meta: Option<String>,
    title_emitted: bool,

    tag_stack: Vec<Tag>,
    mask_stack: Vec<u64>,

    open_level_refs: Vec<OpenLevelRef>,
    active_section: Option<ActiveSection>,

    section_path_counts: HashMap<String, usize>,
    section_key_counts: HashMap<String, usize>,
}

impl ParserState {
    fn new(title_num: &str) -> Self {
        Self {
            title_num: title_num.to_string(),
            title_name_main: None,
            title_name_meta: None,
            title_emitted: false,
            tag_stack: Vec::new(),
            mask_stack: Vec::new(),
            open_level_refs: Vec::new(),
            active_section: None,
            section_path_counts: HashMap::new(),
            section_key_counts: HashMap::new(),
        }
    }

    fn current_mask(&self) -> u64 {
        self.mask_stack.last().copied().unwrap_or(0)
    }

    fn title_name(&self) -> String {
        self.title_name_main
            .as_ref()
            .or(self.title_name_meta.as_ref())
            .cloned()
            .unwrap_or_else(|| format!("Title {}", self.title_num))
    }
}

pub fn parse_usc_xml(xml: &str, title_num: &str, _source_url: &str) -> USCParseResult {
    let mut result = USCParseResult {
        title_num: title_num.to_string(),
        title_name: format!("Title {}", title_num),
        levels: Vec::new(),
        sections: Vec::new(),
    };

    parse_usc_xml_stream(xml, title_num, |event| match event {
        USCStreamEvent::Title(name) => result.title_name = name,
        USCStreamEvent::Level(level) => result.levels.push(level),
        USCStreamEvent::Section(section) => result.sections.push(section),
    });

    result
}

pub fn parse_usc_xml_stream<F>(xml: &str, title_num: &str, mut emit: F)
where
    F: FnMut(USCStreamEvent),
{
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut state = ParserState::new(title_num);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => handle_start(&mut state, &e),
            Ok(Event::Empty(e)) => {
                handle_start(&mut state, &e);
                handle_end(&mut state, e.local_name().as_ref(), &mut emit);
            }
            Ok(Event::Text(t)) => {
                if let Ok(text) = t.unescape() {
                    handle_text(&mut state, &text, &mut emit);
                }
            }
            Ok(Event::CData(t)) => {
                let text = String::from_utf8_lossy(t.as_ref());
                handle_text(&mut state, &text, &mut emit);
            }
            Ok(Event::End(e)) => handle_end(&mut state, e.local_name().as_ref(), &mut emit),
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if !state.title_emitted {
        emit(USCStreamEvent::Title(state.title_name()));
    }
}

fn handle_start(state: &mut ParserState, e: &BytesStart<'_>) {
    let name = e.local_name();
    let name_ref = name.as_ref();
    let current_tag = classify(name_ref);

    let parent_mask = state.current_mask();
    if let Some(tag) = current_tag {
        state.tag_stack.push(tag);
        state.mask_stack.push(parent_mask | bit(tag));
    }

    let mask = state.current_mask();
    let attrs = Attributes::new(e);

    if current_tag.is_some_and(is_level_tag) {
        let level_type = level_tag_str(current_tag.unwrap());
        let raw_identifier = attrs.get(AttrName::Identifier);
        let native_id = raw_identifier
            .as_deref()
            .and_then(strip_usc_prefix)
            .map(|s| s.to_string());
        let open_identifier = native_id.clone().unwrap_or_else(|| {
            let parent = state
                .open_level_refs
                .last()
                .map(|level| level.identifier.clone())
                .unwrap_or_else(|| format!("t{}/root", state.title_num));
            format!("{parent}/{}-unknown", level_type_to_prefix(level_type))
        });
        let parent_identifier = if let Some(ref id) = native_id {
            Some(parent_from_native_id(id))
        } else {
            state
                .open_level_refs
                .last()
                .map(|level| level.identifier.clone())
                .or_else(|| Some(format!("t{}/root", state.title_num)))
        };
        state.open_level_refs.push(OpenLevelRef {
            depth: state.tag_stack.len(),
            level_type,
            identifier: open_identifier,
            parent_identifier,
            raw_identifier,
            capture: NumHeadingCapture {
                num: String::new(),
                heading: String::new(),
            },
        });
    }

    if current_tag == Some(Tag::Section) && !in_note_or_quoted(mask) {
        let identifier = attrs.get(AttrName::Identifier);
        let section_num = identifier
            .as_deref()
            .and_then(section_num_from_identifier)
            .or_else(|| attrs.get(AttrName::Value))
            .unwrap_or_default();

        let parent_ref = state
            .open_level_refs
            .last()
            .map(|level| USCParentRef::Level {
                identifier: level.identifier.clone(),
                level_type: level.level_type,
            })
            .unwrap_or_else(|| USCParentRef::Title {
                title_num: state.title_num.clone(),
            });

        state.active_section = Some(ActiveSection {
            depth: state.tag_stack.len(),
            capture: NumHeadingCapture::with_num(normalize_section_num(&section_num)),
            identifier,
            parent_ref,
            body_frames: Vec::new(),
            body_parts: Vec::new(),
            free_text: String::new(),
            source_credit: String::new(),
            amendments: Vec::new(),
            notes: Vec::new(),
            active_notes: Vec::new(),
        });
    }

    if let Some(section) = &mut state.active_section {
        if section.depth < state.tag_stack.len()
            && current_tag.is_some_and(is_body_block_tag)
            && !in_body_excluded_context(mask)
            && !(current_tag == Some(Tag::Heading) && section.depth + 1 == state.tag_stack.len())
        {
            section.body_frames.push(BodyFrame {
                depth: state.tag_stack.len(),
                text: String::new(),
            });
        }

        if current_tag.is_some_and(is_inline_separator_tag) {
            let target = section.target_text_mut();
            if !target.is_empty() && !target.ends_with(' ') && !target.ends_with('\n') {
                target.push(' ');
            }
        }

        if current_tag == Some(Tag::Note) && mask & bit(Tag::QuotedContent) == 0 {
            section.active_notes.push(ActiveNote {
                depth: state.tag_stack.len(),
                topic: attrs.get(AttrName::Topic),
                heading: String::new(),
                text: String::new(),
            });
        }

        if current_tag.is_some_and(is_body_decorated_tag)
            && !in_body_excluded_context(mask)
            && !(current_tag == Some(Tag::Heading) && section.depth + 1 == state.tag_stack.len())
        {
            section.target_text_mut().push_str("**");
        }

        if current_tag == Some(Tag::Num) {
            if let Some(value) = attrs.get(AttrName::Value) {
                if section.capture.num.is_empty() {
                    section.capture.num = normalize_section_num(&value);
                }
            }
        }
    }

    if current_tag == Some(Tag::Num) {
        if let Some(level) = state.open_level_refs.last_mut() {
            if is_level_num(&state.tag_stack, level.depth) && level.capture.num.is_empty() {
                if let Some(value) = attrs.get(AttrName::Value) {
                    level.capture.num = normalize_section_num(&value);
                }
            }
        }
    }
}

fn handle_text<F>(state: &mut ParserState, raw_text: &str, emit: &mut F)
where
    F: FnMut(USCStreamEvent),
{
    let text = normalize_text(raw_text);
    if text.is_empty() {
        return;
    }

    let mask = state.current_mask();

    if !state.title_emitted && is_main_title_heading(&state.tag_stack) {
        state.title_name_main = Some(text.to_string());
        emit(USCStreamEvent::Title(state.title_name()));
        state.title_emitted = true;
    }

    if state.title_name_meta.is_none() && is_meta_title(&state.tag_stack) {
        state.title_name_meta = Some(text.to_string());
    }

    if let Some(level) = state.open_level_refs.last_mut() {
        if is_level_num(&state.tag_stack, level.depth) {
            if level.capture.num.is_empty() {
                level.capture.num = text.to_string();
            }
        } else if is_level_heading(&state.tag_stack, level.depth) {
            append_text(&mut level.capture.heading, &text);
        }
    }

    if let Some(section) = &mut state.active_section {
        if is_section_heading(&state.tag_stack, section.depth) {
            append_text(&mut section.capture.heading, &text);
            return;
        }

        if is_source_credit(&state.tag_stack, section.depth) {
            append_text(&mut section.source_credit, &text);
            return;
        }

        if let Some(note) = section.active_notes.last_mut() {
            if is_note_heading(&state.tag_stack, note.depth) {
                append_text(&mut note.heading, &text);
            } else {
                append_text(&mut note.text, &text);
            }
            return;
        }

        if !in_body_excluded_context(mask) {
            let target = section.target_text_mut();
            append_text(target, &text);
        }
    }
}

fn handle_end<F>(state: &mut ParserState, local_name: &[u8], emit: &mut F)
where
    F: FnMut(USCStreamEvent),
{
    let current_tag = classify(local_name);
    let mask = state.current_mask();

    if let Some(section) = &mut state.active_section {
        if current_tag.is_some_and(is_body_decorated_tag)
            && !in_body_excluded_context(mask)
            && !(current_tag == Some(Tag::Heading) && section.depth + 1 == state.tag_stack.len())
        {
            section.target_text_mut().push_str("**");
        }

        if current_tag == Some(Tag::Note) {
            if let Some(note) = section.active_notes.last() {
                if note.depth == state.tag_stack.len() {
                    let note = section.active_notes.pop().unwrap();
                    let heading = normalize_heading(&note.heading);
                    let mut merged = String::new();
                    if !heading.is_empty() {
                        append_text(&mut merged, &heading);
                    }
                    if !note.text.is_empty() {
                        if !merged.is_empty() {
                            merged.push(' ');
                        }
                        append_text(&mut merged, &note.text);
                    }
                    let is_amendments = note
                        .topic
                        .as_deref()
                        .map(|topic| topic.eq_ignore_ascii_case("amendments"))
                        .unwrap_or(false)
                        || heading.to_ascii_lowercase().contains("amendments");

                    if !merged.is_empty() {
                        if is_amendments {
                            section.amendments.push(merged);
                        } else {
                            section.notes.push(merged);
                        }
                    }
                }
            }
        }

        if current_tag.is_some_and(is_body_block_tag) {
            if let Some(frame) = section.body_frames.last() {
                if frame.depth == state.tag_stack.len() {
                    let frame = section.body_frames.pop().unwrap();
                    let cleaned = clean_body_fragment(&frame.text);
                    if !cleaned.is_empty() {
                        if let Some(parent) = section.body_frames.last_mut() {
                            if !parent.text.is_empty() {
                                parent.text.push_str("\n\n");
                            }
                            parent.text.push_str(&cleaned);
                        } else {
                            section.body_parts.push(cleaned);
                        }
                    }
                }
            }
        }
    }

    if current_tag == Some(Tag::Section) {
        if let Some(section) = &state.active_section {
            if section.depth == state.tag_stack.len() {
                let section = state.active_section.take().unwrap();
                let base_num = if section.capture.num.is_empty() {
                    section
                        .identifier
                        .as_deref()
                        .and_then(section_num_from_identifier)
                        .map(|value| normalize_section_num(&value))
                        .unwrap_or_else(|| "unknown".to_string())
                } else {
                    section.capture.num.clone()
                };

                let base_path = format!("/statutes/usc/section/{}/{}", state.title_num, base_num);
                let path = uniquify(&mut state.section_path_counts, &base_path);

                let base_key = format!("{}:{}", state.title_num, base_num);
                let section_key = uniquify(&mut state.section_key_counts, &base_key);

                let mut body_parts = section.body_parts;
                let trailing = clean_body_fragment(&section.free_text);
                if !trailing.is_empty() {
                    body_parts.push(trailing);
                }
                let body = body_parts.join("\n\n");

                emit(USCStreamEvent::Section(USCSection {
                    title_num: state.title_num.clone(),
                    section_num: base_num,
                    section_key,
                    heading: normalize_heading(&section.capture.heading),
                    body,
                    source_credit: clean_body_fragment(&section.source_credit),
                    amendments: section.amendments.join("\n\n"),
                    note: section.notes.join("\n\n"),
                    path,
                    parent_ref: section.parent_ref,
                }));
            }
        }
    }

    if current_tag.is_some_and(is_level_tag) {
        if let Some(level) = state.open_level_refs.last() {
            if level.depth == state.tag_stack.len() {
                let level = state.open_level_refs.pop().unwrap();
                let fallback_num = if level.capture.num.is_empty() {
                    level
                        .raw_identifier
                        .as_deref()
                        .and_then(level_num_from_identifier)
                        .unwrap_or_default()
                } else {
                    level.capture.num.clone()
                };
                let num = normalize_section_num(&fallback_num);
                let mut identifier = level.identifier.clone();
                if !num.is_empty() && identifier.ends_with("-unknown") {
                    let parent = level
                        .parent_identifier
                        .clone()
                        .unwrap_or_else(|| format!("t{}/root", state.title_num));
                    let prefix = level_type_to_prefix(level.level_type);
                    identifier = format!("{parent}/{prefix}{}", slug_part(&num));
                }

                // Derive path using the friendly title-X/chapter-Y format
                let friendly = level
                    .raw_identifier
                    .as_deref()
                    .and_then(|raw| level_identifier_from_path(raw, &state.title_num));
                let path_suffix = friendly
                    .as_deref()
                    .and_then(|f| f.strip_prefix(&format!("title-{}/", state.title_num)))
                    .unwrap_or(&identifier);
                let path = format!("/statutes/usc/{}/{}", state.title_num, path_suffix);

                let usc_level = USCLevel {
                    title_num: state.title_num.clone(),
                    level_type: level.level_type,
                    level_index: usc_level_index(level.level_type).unwrap_or(0),
                    identifier: identifier.clone(),
                    parent_identifier: level.parent_identifier.clone(),
                    num,
                    heading: normalize_heading(&level.capture.heading),
                    path,
                };
                emit(USCStreamEvent::Level(usc_level.clone()));
            }
        }
    }

    if let Some(tag) = current_tag {
        if state.tag_stack.last().copied() == Some(tag) {
            state.tag_stack.pop();
            state.mask_stack.pop();
        }
    }
}

const LEVEL_TAG_MASK: u64 = bit(Tag::Subtitle)
    | bit(Tag::Part)
    | bit(Tag::Subpart)
    | bit(Tag::Chapter)
    | bit(Tag::Subchapter)
    | bit(Tag::Division)
    | bit(Tag::Subdivision);
const BODY_BLOCK_TAG_MASK: u64 = bit(Tag::Subsection)
    | bit(Tag::Paragraph)
    | bit(Tag::Subparagraph)
    | bit(Tag::Clause)
    | bit(Tag::Subclause)
    | bit(Tag::Item)
    | bit(Tag::Subitem)
    | bit(Tag::Chapeau)
    | bit(Tag::Continuation)
    | bit(Tag::P);
const BODY_DECORATED_TAG_MASK: u64 = bit(Tag::Num) | bit(Tag::Heading);
const LEVEL_ANCESTOR_TAG_MASK: u64 = bit(Tag::Title) | LEVEL_TAG_MASK;
const INLINE_SEPARATOR_TAG_MASK: u64 =
    bit(Tag::Content) | bit(Tag::Chapeau) | bit(Tag::Continuation);

#[inline(always)]
fn is_level_tag(tag: Tag) -> bool {
    bit(tag) & LEVEL_TAG_MASK != 0
}

#[inline(always)]
fn is_body_block_tag(tag: Tag) -> bool {
    bit(tag) & BODY_BLOCK_TAG_MASK != 0
}

#[inline(always)]
fn is_body_decorated_tag(tag: Tag) -> bool {
    bit(tag) & BODY_DECORATED_TAG_MASK != 0
}

#[inline(always)]
fn is_inline_separator_tag(tag: Tag) -> bool {
    bit(tag) & INLINE_SEPARATOR_TAG_MASK != 0
}

fn is_main_title_heading(stack: &[Tag]) -> bool {
    stack.ends_with(&[Tag::Main, Tag::Title, Tag::Heading])
}

fn is_meta_title(stack: &[Tag]) -> bool {
    stack.ends_with(&[Tag::Meta, Tag::Title])
}

fn is_level_num(stack: &[Tag], level_depth: usize) -> bool {
    stack.len() == level_depth + 1
        && stack.ends_with(&[Tag::Num])
        && is_level_ancestor(stack, level_depth)
}

fn is_level_heading(stack: &[Tag], level_depth: usize) -> bool {
    stack.len() == level_depth + 1
        && stack.ends_with(&[Tag::Heading])
        && is_level_ancestor(stack, level_depth)
}

fn is_level_ancestor(stack: &[Tag], level_depth: usize) -> bool {
    if level_depth == 0 || stack.len() < level_depth {
        return false;
    }
    bit(stack[level_depth - 1]) & LEVEL_ANCESTOR_TAG_MASK != 0
}

fn is_section_heading(stack: &[Tag], section_depth: usize) -> bool {
    stack.len() == section_depth + 1 && stack.ends_with(&[Tag::Section, Tag::Heading])
}

fn is_source_credit(stack: &[Tag], section_depth: usize) -> bool {
    stack.len() >= section_depth + 1 && stack.ends_with(&[Tag::Section, Tag::SourceCredit])
}

fn is_note_heading(stack: &[Tag], note_depth: usize) -> bool {
    stack.len() >= note_depth + 1 && stack.ends_with(&[Tag::Note, Tag::Heading])
}

#[inline(always)]
fn in_note_or_quoted(mask: u64) -> bool {
    mask & (bit(Tag::Note) | bit(Tag::QuotedContent)) != 0
}

#[inline(always)]
fn in_body_excluded_context(mask: u64) -> bool {
    mask & (bit(Tag::Note) | bit(Tag::SourceCredit) | bit(Tag::QuotedContent)) != 0
}

fn normalize_text(raw: &str) -> Cow<'_, str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Cow::Borrowed("");
    }
    WHITESPACE_RE.replace_all(trimmed, " ")
}

fn append_text(target: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    if target.is_empty() {
        target.push_str(text);
        return;
    }

    let first = text.chars().next().unwrap();
    let needs_space = !target.ends_with(' ')
        && !target.ends_with('\n')
        && !target.ends_with("**")
        && !matches!(first, ',' | '.' | ';' | ':' | ')' | ']' | '?' | '!');

    if needs_space {
        target.push(' ');
    }
    target.push_str(text);
}

fn clean_body_fragment(text: &str) -> String {
    let out = text.replace('\u{a0}', " ");
    MULTI_NEWLINE_RE
        .replace_all(&out, "\n\n")
        .trim()
        .to_string()
}

fn normalize_heading(heading: &str) -> String {
    let mut out = clean_body_fragment(heading);
    if out.ends_with(']') {
        out.pop();
        out = out.trim_end().to_string();
    }
    if out.starts_with('[') && out.ends_with(']') {
        out = out[1..out.len() - 1].trim().to_string();
    }
    out
}

fn normalize_section_num(value: &str) -> String {
    UNICODE_DASH_RE.replace_all(value.trim(), "-").into_owned()
}

fn slug_part(value: &str) -> String {
    UNICODE_DASH_RE.replace_all(value, "-").into_owned()
}

fn strip_usc_prefix(raw: &str) -> Option<&str> {
    raw.strip_prefix("/us/usc/")
}

fn parent_from_native_id(native_id: &str) -> String {
    match native_id.rsplit_once('/') {
        Some((parent, _)) => {
            if is_title_path(parent) {
                format!("{parent}/root")
            } else {
                parent.to_string()
            }
        }
        None => String::new(),
    }
}

fn is_title_path(path: &str) -> bool {
    let segment = path.rsplit('/').next().unwrap_or(path);
    segment.starts_with('t') && segment[1..].chars().all(|c| c.is_ascii_digit())
}

fn level_type_to_prefix(level_type: &str) -> &str {
    match level_type {
        "subtitle" => "st",
        "subchapter" => "sch",
        "chapter" => "ch",
        "subpart" => "spt",
        "part" => "pt",
        "subdivision" => "sd",
        "division" => "d",
        _ => level_type,
    }
}

fn section_num_from_identifier(identifier: &str) -> Option<String> {
    identifier
        .rsplit('/')
        .next()
        .and_then(|part| part.strip_prefix('s'))
        .map(ToString::to_string)
}

fn level_num_from_identifier(identifier: &str) -> Option<String> {
    let segment = identifier.rsplit('/').next()?;
    let caps = LEVEL_SEGMENT_RE.captures(segment)?;
    Some(caps["num"].to_string())
}

fn level_identifier_from_path(identifier: &str, title_num: &str) -> Option<String> {
    let mut parts = Vec::new();
    for raw in identifier.split('/') {
        if raw.is_empty() || raw == "us" || raw == "usc" {
            continue;
        }
        if let Some(caps) = LEVEL_SEGMENT_RE.captures(raw) {
            let prefix = &caps["prefix"];
            let num = &caps["num"];
            match prefix {
                "t" => {
                    if num == title_num {
                        parts.push(format!("title-{title_num}"));
                    }
                }
                _ => {
                    let type_name = match prefix {
                        "st" => "subtitle",
                        "sch" => "subchapter",
                        "ch" => "chapter",
                        "spt" => "subpart",
                        "pt" => "part",
                        "sd" => "subdivision",
                        "d" => "division",
                        _ => unreachable!(),
                    };
                    parts.push(format!("{type_name}-{num}"));
                }
            }
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn uniquify(counts: &mut HashMap<String, usize>, base: &str) -> String {
    let entry = counts.entry(base.to_string()).or_insert(0);
    *entry += 1;
    if *entry == 1 {
        base.to_string()
    } else {
        format!("{base}-{}", *entry)
    }
}

pub fn usc_level_index(level_type: &str) -> Option<usize> {
    match level_type {
        "title" => Some(0),
        "subtitle" => Some(1),
        "division" => Some(2),
        "subdivision" => Some(3),
        "chapter" => Some(4),
        "subchapter" => Some(5),
        "part" => Some(6),
        "subpart" => Some(7),
        _ => None,
    }
}

pub fn section_level_index() -> usize {
    8
}

pub fn title_sort_key(title_num: &str) -> f64 {
    if let Ok(v) = title_num.parse::<f64>() {
        return v;
    }

    let mut chars = title_num.chars();
    let numeric_part: String = chars.by_ref().take_while(|c| c.is_ascii_digit()).collect();
    let suffix: String = chars.collect();

    if numeric_part.is_empty() {
        return f64::INFINITY;
    }

    let base = numeric_part.parse::<f64>().unwrap_or(f64::INFINITY);
    if suffix.is_empty() {
        return base;
    }

    let letter = suffix.chars().next().unwrap().to_ascii_lowercase();
    let offset = if letter.is_ascii_lowercase() {
        ((letter as u8) - b'a' + 1) as f64 / 100.0
    } else {
        0.99
    };
    base + offset
}
