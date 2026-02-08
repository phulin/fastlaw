use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;

/// Canonical organizational level hierarchy for USC.
pub const USC_LEVEL_HIERARCHY: &[&str] = &[
    "title",
    "subtitle",
    "chapter",
    "subchapter",
    "part",
    "subpart",
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
    "content",
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

const SECTION_SKIP_TAGS: &[&str] = &["sourceCredit", "notes"];

fn is_section_skip_tag(tag: &str) -> bool {
    SECTION_SKIP_TAGS.contains(&tag)
}

// ─── Public types ──────────────────────────────────────────

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
    pub history_short: String,
    pub history_long: String,
    pub citations: String,
    pub path: String,
    pub doc_id: String,
    pub parent_ref: USCParentRef,
}

#[derive(Debug, Clone)]
pub struct USCSectionRef {
    pub section_key: String,
    pub title_num: String,
    pub section_num: String,
    pub heading: String,
    pub parent_ref: USCParentRef,
}

#[derive(Debug, Clone)]
pub enum USCParentRef {
    Title { title_num: String },
    Level { level_type: String, identifier: String },
}

#[derive(Debug, Clone)]
pub enum USCStreamEvent {
    Title { title_num: String, title_name: String },
    Level(USCLevel),
    Section(USCSection),
}

#[derive(Debug, Clone)]
pub enum USCStructureEvent {
    Title { title_num: String, title_name: String },
    Level(USCLevel),
    Section(USCSectionRef),
}

pub struct ParseResult {
    pub sections: Vec<USCSection>,
    pub levels: Vec<USCLevel>,
    pub title_num: String,
    pub title_name: String,
}

// ─── Helper functions ──────────────────────────────────────

fn normalize_tag_name(tag_name: &str) -> &str {
    match tag_name.find(':') {
        Some(idx) => &tag_name[idx + 1..],
        None => tag_name,
    }
}

pub fn strip_leading_zeros(value: &str) -> String {
    // Match pattern: optional leading zeros, digits, optional letter suffix
    let mut chars = value.chars().peekable();
    let mut digits = String::new();
    let mut suffix = String::new();

    // Skip leading zeros but keep at least one digit
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
        return value.to_string();
    }

    // Collect remaining letter suffix
    for c in chars {
        if c.is_ascii_alphabetic() {
            suffix.push(c.to_ascii_lowercase());
        } else {
            // Non-matching pattern, return original
            return value.to_string();
        }
    }

    format!("{digits}{suffix}")
}

pub fn normalized_whitespace(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    s.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

fn parse_title_from_identifier(ident: &str) -> Option<String> {
    if !ident.starts_with("/us/usc/") {
        return None;
    }
    let rest = ident["/us/usc/".len()..].trim_matches('/');
    for part in rest.split('/') {
        if part.starts_with('t') {
            return Some(strip_leading_zeros(&part[1..]));
        }
    }
    None
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
        let first_char = num_part.chars().next().unwrap();
        if !first_char.is_ascii_alphanumeric() {
            continue;
        }

        // Check for longer prefix match
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

// ─── Parser state ──────────────────────────────────────────

#[derive(Debug, Clone)]
struct LevelFrame {
    level_type: String,
    num: Option<String>,
    identifier: Option<String>,
    heading: String,
    parent_identifier: Option<String>,
    emitted: bool,
    bracketed_num: bool,
}

#[derive(Debug, Clone)]
struct StructureSectionFrame {
    #[allow(dead_code)]
    title_num: String,
    section_num: Option<String>,
    heading: String,
    parent_ref: USCParentRef,
    bracketed_num: bool,
}

#[derive(Debug, Clone)]
struct FullSectionFrame {
    #[allow(dead_code)]
    title_num: String,
    section_num: Option<String>,
    heading: String,
    body_parts: Vec<String>,
    history_short: String,
    history_long_parts: Vec<String>,
    citations_parts: Vec<CitationEntry>,
    parent_ref: USCParentRef,
    bracketed_num: bool,
}

#[derive(Debug, Clone)]
struct CitationEntry {
    heading: String,
    body: String,
}

#[derive(Debug, Clone)]
struct NoteFrame {
    topic: String,
    role: String,
    heading_text: String,
    p_parts: Vec<String>,
}

struct SharedDocState {
    tag_stack: Vec<String>,
    level_stack: Vec<LevelFrame>,
    section_counts: HashMap<String, usize>,
    title_num: String,
    title_name: String,
    title_emitted: bool,
    meta_depth: usize,
    meta_title_capture: bool,
    meta_title_buffer: String,
    num_depth: usize,
    num_buffer: String,
    num_target: Option<NumTarget>,
    note_depth: usize,
    quoted_content_depth: usize,
    ignored_section_depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum NumTarget {
    Level,
    Section,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum HeadingTarget {
    Level,
    Section,
    Note,
}

impl SharedDocState {
    fn new(file_title: &str) -> Self {
        Self {
            tag_stack: Vec::new(),
            level_stack: Vec::new(),
            section_counts: HashMap::new(),
            title_num: file_title.to_string(),
            title_name: String::new(),
            title_emitted: false,
            meta_depth: 0,
            meta_title_capture: false,
            meta_title_buffer: String::new(),
            num_depth: 0,
            num_buffer: String::new(),
            num_target: None,
            note_depth: 0,
            quoted_content_depth: 0,
            ignored_section_depth: 0,
        }
    }

}

// ─── Structure parser ──────────────────────────────────────

struct StructureParser {
    shared: SharedDocState,
    events: Vec<USCStructureEvent>,
    current_section: Option<StructureSectionFrame>,
    heading_target: Option<HeadingTarget>,
    heading_buffer: String,
}

impl StructureParser {
    fn new(file_title: &str) -> Self {
        Self {
            shared: SharedDocState::new(file_title),
            events: Vec::new(),
            current_section: None,
            heading_target: None,
            heading_buffer: String::new(),
        }
    }

    fn ensure_title_num(&mut self, ident: Option<&str>) {
        if let Some(ident) = ident {
            if let Some(parsed) = parse_title_from_identifier(ident) {
                self.shared.title_num = parsed;
            }
        }
    }

    fn emit_title_if_needed(&mut self) {
        if self.shared.title_emitted {
            return;
        }
        if self.shared.title_name.is_empty() {
            self.shared.title_name = format!("Title {}", self.shared.title_num);
        }
        self.events.push(USCStructureEvent::Title {
            title_num: self.shared.title_num.clone(),
            title_name: self.shared.title_name.clone(),
        });
        self.shared.title_emitted = true;
    }

    fn create_level_frame(&self, level_type: &str, identifier: Option<&str>) -> LevelFrame {
        let level_num = identifier.and_then(|id| parse_level_num_from_identifier(id, level_type));
        let parent_identifier = if self.shared.level_stack.is_empty() {
            Some(format!("{}-title", self.shared.title_num))
        } else {
            self.shared.level_stack.last().and_then(|f| f.identifier.clone())
        };
        let prefix = level_id_prefix(level_type);
        let computed_identifier = level_num
            .as_ref()
            .map(|num| format!("{}-{}{}", self.shared.title_num, prefix, num));
        LevelFrame {
            level_type: level_type.to_string(),
            num: level_num,
            identifier: computed_identifier,
            heading: String::new(),
            parent_identifier,
            emitted: false,
            bracketed_num: false,
        }
    }

    #[allow(dead_code)]
    fn ensure_level_identifier(&self, frame: &mut LevelFrame) {
        if frame.identifier.is_some() || frame.num.is_none() {
            return;
        }
        let prefix = level_id_prefix(&frame.level_type);
        frame.identifier = Some(format!(
            "{}-{}{}",
            self.shared.title_num,
            prefix,
            frame.num.as_ref().unwrap()
        ));
    }

    fn emit_level_if_ready(&mut self, frame_idx: usize) {
        let frame = &mut self.shared.level_stack[frame_idx];
        // Ensure identifier
        if frame.identifier.is_none() && frame.num.is_some() {
            let prefix = level_id_prefix(&frame.level_type);
            frame.identifier = Some(format!(
                "{}-{}{}",
                self.shared.title_num,
                prefix,
                frame.num.as_ref().unwrap()
            ));
        }
        if frame.emitted || frame.identifier.is_none() || frame.num.is_none() {
            return;
        }
        let level = USCLevel {
            level_type: frame.level_type.clone(),
            level_index: usc_level_index(&frame.level_type).unwrap_or(0),
            identifier: frame.identifier.clone().unwrap(),
            num: frame.num.clone().unwrap(),
            heading: frame.heading.clone(),
            title_num: self.shared.title_num.clone(),
            parent_identifier: frame.parent_identifier.clone(),
        };
        self.events.push(USCStructureEvent::Level(level));
        self.shared.level_stack[frame_idx].emitted = true;
    }

    fn emit_pending_levels(&mut self) {
        let len = self.shared.level_stack.len();
        for i in 0..len {
            self.emit_level_if_ready(i);
        }
    }

    fn parse_section_parent_ref(&self) -> USCParentRef {
        if let Some(parent_level) = self.shared.level_stack.last() {
            if let Some(ref identifier) = parent_level.identifier {
                return USCParentRef::Level {
                    level_type: parent_level.level_type.clone(),
                    identifier: identifier.clone(),
                };
            }
        }
        USCParentRef::Title {
            title_num: self.shared.title_num.clone(),
        }
    }

    fn close_num_target(&mut self) {
        if self.shared.num_depth == 0 {
            return;
        }
        self.shared.num_depth -= 1;
        if self.shared.num_depth > 0 {
            return;
        }

        let text = self.shared.num_buffer.trim().to_string();
        if text.starts_with('[') {
            if self.shared.num_target == Some(NumTarget::Section) {
                if let Some(ref mut section) = self.current_section {
                    section.bracketed_num = true;
                }
            }
            if self.shared.num_target == Some(NumTarget::Level) {
                if let Some(frame) = self.shared.level_stack.last_mut() {
                    frame.bracketed_num = true;
                }
            }
        }

        self.shared.num_buffer.clear();
        self.shared.num_target = None;
    }

    fn handle_open(&mut self, tag_name: &str, parent_tag: Option<&str>, attrs: &HashMap<String, String>) {
        let identifier = attrs.get("identifier").map(|s| s.as_str());

        if let Some(ident) = identifier {
            self.ensure_title_num(Some(ident));
        }

        if tag_name == "meta" {
            self.shared.meta_depth += 1;
        }

        if self.shared.meta_depth > 0 && tag_name == "title" {
            self.shared.meta_title_capture = true;
            self.shared.meta_title_buffer.clear();
        }

        if tag_name == "title" && parent_tag == Some("main") {
            self.emit_title_if_needed();
        }

        if tag_name == "note" {
            self.shared.note_depth += 1;
        }

        if tag_name == "quotedContent" {
            self.shared.quoted_content_depth += 1;
        }

        if is_usc_level(tag_name) {
            let frame = self.create_level_frame(tag_name, identifier);
            self.shared.level_stack.push(frame);
        }

        if tag_name == "num" {
            self.shared.num_depth += 1;
            if self.shared.num_depth == 1 {
                self.shared.num_buffer.clear();
                if self.current_section.is_some() {
                    self.shared.num_target = Some(NumTarget::Section);
                } else if !self.shared.level_stack.is_empty() {
                    self.shared.num_target = Some(NumTarget::Level);
                } else {
                    self.shared.num_target = None;
                }
            }
        }

        // Structure-specific open
        if tag_name == "section" {
            if self.shared.note_depth > 0 || self.shared.quoted_content_depth > 0 {
                self.shared.ignored_section_depth += 1;
                return;
            }
            self.emit_pending_levels();
            self.current_section = Some(StructureSectionFrame {
                title_num: self.shared.title_num.clone(),
                section_num: identifier.and_then(parse_section_from_identifier),
                heading: String::new(),
                parent_ref: self.parse_section_parent_ref(),
                bracketed_num: false,
            });
            return;
        }

        if let Some(ref mut section) = self.current_section {
            if tag_name == "num" {
                if let Some(value) = attrs.get("value") {
                    if section.section_num.is_none() {
                        section.section_num = Some(strip_leading_zeros(value));
                    }
                }
            }
        }

        if tag_name == "heading" {
            if self.current_section.is_some() && parent_tag == Some("section") {
                self.heading_target = Some(HeadingTarget::Section);
                self.heading_buffer.clear();
            } else if !self.shared.level_stack.is_empty()
                && parent_tag
                    .map(|t| USC_LEVEL_HIERARCHY.contains(&t))
                    .unwrap_or(false)
            {
                self.heading_target = Some(HeadingTarget::Level);
                self.heading_buffer.clear();
            }
        }
    }

    fn handle_text(&mut self, text: &str) {
        if self.shared.meta_title_capture {
            self.shared.meta_title_buffer.push_str(text);
        }
        if self.heading_target.is_some() {
            self.heading_buffer.push_str(text);
        }
        if self.shared.num_depth > 0 {
            self.shared.num_buffer.push_str(text);
        }
    }

    fn handle_close(&mut self, tag_name: &str) {
        if tag_name == "section" && self.shared.ignored_section_depth > 0 {
            self.shared.ignored_section_depth -= 1;
            return;
        }

        if self.heading_target.is_some() && tag_name == "heading" {
            let mut heading = normalized_whitespace(&self.heading_buffer);
            match self.heading_target {
                Some(HeadingTarget::Section) => {
                    if let Some(ref mut section) = self.current_section {
                        if section.bracketed_num && heading.ends_with(']') {
                            heading = heading[..heading.len() - 1].trim().to_string();
                        }
                        section.heading = heading;
                    }
                }
                Some(HeadingTarget::Level) => {
                    if let Some(idx) = self.shared.level_stack.len().checked_sub(1) {
                        let frame = &mut self.shared.level_stack[idx];
                        if frame.bracketed_num && heading.ends_with(']') {
                            heading = heading[..heading.len() - 1].trim().to_string();
                        }
                        frame.heading = heading;
                        // release the mutable borrow before calling emit_level_if_ready
                        self.emit_level_if_ready(idx);
                    }
                }
                _ => {}
            }
            self.heading_target = None;
            self.heading_buffer.clear();
        }

        if tag_name == "section" && self.current_section.is_some() {
            self.close_structure_section();
        }

        // Shared close
        if tag_name == "meta" {
            self.shared.meta_depth = self.shared.meta_depth.saturating_sub(1);
        }

        if self.shared.meta_title_capture && tag_name == "title" && self.shared.meta_depth > 0 {
            let candidate = self.shared.meta_title_buffer.trim().to_string();
            if !candidate.is_empty() {
                self.shared.title_name = candidate;
            }
            self.shared.meta_title_capture = false;
            self.shared.meta_title_buffer.clear();
        }

        if tag_name == "num" {
            self.close_num_target();
        }

        if tag_name == "note" {
            self.shared.note_depth = self.shared.note_depth.saturating_sub(1);
        }

        if tag_name == "quotedContent" {
            self.shared.quoted_content_depth = self.shared.quoted_content_depth.saturating_sub(1);
        }

        if is_usc_level(tag_name) {
            if let Some(idx) = self.shared.level_stack.len().checked_sub(1) {
                self.emit_level_if_ready(idx);
                self.shared.level_stack.pop();
            }
        }
    }

    fn close_structure_section(&mut self) {
        let section = match self.current_section.take() {
            Some(s) => s,
            None => return,
        };

        let section_num = match section.section_num {
            Some(ref num) => num.clone(),
            None => return,
        };

        let section_key = format!("{}-{}", self.shared.title_num, section_num);
        let count = self.shared.section_counts.entry(section_key).or_insert(0);
        *count += 1;
        let final_section_num = if *count == 1 {
            section_num
        } else {
            format!("{}-{}", section_num, count)
        };

        self.events.push(USCStructureEvent::Section(USCSectionRef {
            section_key: format!("{}:{}", self.shared.title_num, final_section_num),
            title_num: self.shared.title_num.clone(),
            section_num: final_section_num,
            heading: section.heading,
            parent_ref: section.parent_ref,
        }));
    }

    fn drain_events(&mut self) -> Vec<USCStructureEvent> {
        std::mem::take(&mut self.events)
    }
}

// ─── Full parser (with section content) ────────────────────

struct FullParser {
    shared: SharedDocState,
    events: Vec<USCStreamEvent>,
    current_section: Option<FullSectionFrame>,
    heading_target: Option<HeadingTarget>,
    heading_buffer: String,
    skip_depth: usize,
    body_capture_depth: usize,
    body_buffer: String,
    source_credit_depth: usize,
    source_credit_buffer: String,
    current_note: Option<NoteFrame>,
    note_p_depth: usize,
    note_p_buffer: String,
    body_heading_depth: usize,
    body_heading_buffer: String,
}

impl FullParser {
    fn new(file_title: &str) -> Self {
        Self {
            shared: SharedDocState::new(file_title),
            events: Vec::new(),
            current_section: None,
            heading_target: None,
            heading_buffer: String::new(),
            skip_depth: 0,
            body_capture_depth: 0,
            body_buffer: String::new(),
            source_credit_depth: 0,
            source_credit_buffer: String::new(),
            current_note: None,
            note_p_depth: 0,
            note_p_buffer: String::new(),
            body_heading_depth: 0,
            body_heading_buffer: String::new(),
        }
    }

    fn ensure_title_num(&mut self, ident: Option<&str>) {
        if let Some(ident) = ident {
            if let Some(parsed) = parse_title_from_identifier(ident) {
                self.shared.title_num = parsed;
            }
        }
    }

    fn emit_title_if_needed(&mut self) {
        if self.shared.title_emitted {
            return;
        }
        if self.shared.title_name.is_empty() {
            self.shared.title_name = format!("Title {}", self.shared.title_num);
        }
        self.events.push(USCStreamEvent::Title {
            title_num: self.shared.title_num.clone(),
            title_name: self.shared.title_name.clone(),
        });
        self.shared.title_emitted = true;
    }

    fn create_level_frame(&self, level_type: &str, identifier: Option<&str>) -> LevelFrame {
        let level_num = identifier.and_then(|id| parse_level_num_from_identifier(id, level_type));
        let parent_identifier = if self.shared.level_stack.is_empty() {
            Some(format!("{}-title", self.shared.title_num))
        } else {
            self.shared.level_stack.last().and_then(|f| f.identifier.clone())
        };
        let prefix = level_id_prefix(level_type);
        let computed_identifier = level_num
            .as_ref()
            .map(|num| format!("{}-{}{}", self.shared.title_num, prefix, num));
        LevelFrame {
            level_type: level_type.to_string(),
            num: level_num,
            identifier: computed_identifier,
            heading: String::new(),
            parent_identifier,
            emitted: false,
            bracketed_num: false,
        }
    }

    fn emit_level_if_ready(&mut self, frame_idx: usize) {
        let frame = &mut self.shared.level_stack[frame_idx];
        if frame.identifier.is_none() && frame.num.is_some() {
            let prefix = level_id_prefix(&frame.level_type);
            frame.identifier = Some(format!(
                "{}-{}{}",
                self.shared.title_num,
                prefix,
                frame.num.as_ref().unwrap()
            ));
        }
        if frame.emitted || frame.identifier.is_none() || frame.num.is_none() {
            return;
        }
        let level = USCLevel {
            level_type: frame.level_type.clone(),
            level_index: usc_level_index(&frame.level_type).unwrap_or(0),
            identifier: frame.identifier.clone().unwrap(),
            num: frame.num.clone().unwrap(),
            heading: frame.heading.clone(),
            title_num: self.shared.title_num.clone(),
            parent_identifier: frame.parent_identifier.clone(),
        };
        self.events.push(USCStreamEvent::Level(level));
        self.shared.level_stack[frame_idx].emitted = true;
    }

    fn emit_pending_levels(&mut self) {
        let len = self.shared.level_stack.len();
        for i in 0..len {
            self.emit_level_if_ready(i);
        }
    }

    fn parse_section_parent_ref(&self) -> USCParentRef {
        if let Some(parent_level) = self.shared.level_stack.last() {
            if let Some(ref identifier) = parent_level.identifier {
                return USCParentRef::Level {
                    level_type: parent_level.level_type.clone(),
                    identifier: identifier.clone(),
                };
            }
        }
        USCParentRef::Title {
            title_num: self.shared.title_num.clone(),
        }
    }

    fn close_num_target(&mut self) {
        if self.shared.num_depth == 0 {
            return;
        }
        self.shared.num_depth -= 1;
        if self.shared.num_depth > 0 {
            return;
        }

        let text = self.shared.num_buffer.trim().to_string();
        if text.starts_with('[') {
            if self.shared.num_target == Some(NumTarget::Section) {
                if let Some(ref mut section) = self.current_section {
                    section.bracketed_num = true;
                }
            }
            if self.shared.num_target == Some(NumTarget::Level) {
                if let Some(frame) = self.shared.level_stack.last_mut() {
                    frame.bracketed_num = true;
                }
            }
        }

        self.shared.num_buffer.clear();
        self.shared.num_target = None;
    }

    fn handle_open(&mut self, tag_name: &str, parent_tag: Option<&str>, attrs: &HashMap<String, String>) {
        let identifier = attrs.get("identifier").map(|s| s.as_str());
        let value = attrs.get("value").map(|s| s.as_str());
        let topic = attrs.get("topic").map(|s| s.as_str());
        let role = attrs.get("role").map(|s| s.as_str());

        // Shared open
        if let Some(ident) = identifier {
            self.ensure_title_num(Some(ident));
        }

        if tag_name == "meta" {
            self.shared.meta_depth += 1;
        }

        if self.shared.meta_depth > 0 && tag_name == "title" {
            self.shared.meta_title_capture = true;
            self.shared.meta_title_buffer.clear();
        }

        if tag_name == "title" && parent_tag == Some("main") {
            self.emit_title_if_needed();
        }

        if tag_name == "note" {
            self.shared.note_depth += 1;
        }

        if tag_name == "quotedContent" {
            self.shared.quoted_content_depth += 1;
        }

        if is_usc_level(tag_name) {
            let frame = self.create_level_frame(tag_name, identifier);
            self.shared.level_stack.push(frame);
        }

        if tag_name == "num" {
            self.shared.num_depth += 1;
            if self.shared.num_depth == 1 {
                self.shared.num_buffer.clear();
                if self.current_section.is_some() {
                    self.shared.num_target = Some(NumTarget::Section);
                } else if !self.shared.level_stack.is_empty() {
                    self.shared.num_target = Some(NumTarget::Level);
                } else {
                    self.shared.num_target = None;
                }
            }
        }

        // Full-specific open
        if tag_name == "section" {
            if self.shared.note_depth > 0 || self.shared.quoted_content_depth > 0 {
                self.shared.ignored_section_depth += 1;
                return;
            }
            self.emit_pending_levels();
            self.current_section = Some(FullSectionFrame {
                title_num: self.shared.title_num.clone(),
                section_num: identifier.and_then(parse_section_from_identifier),
                heading: String::new(),
                body_parts: Vec::new(),
                history_short: String::new(),
                history_long_parts: Vec::new(),
                citations_parts: Vec::new(),
                parent_ref: self.parse_section_parent_ref(),
                bracketed_num: false,
            });
            return;
        }

        if tag_name == "heading" {
            if self.current_note.is_some() {
                if let Some(ref note) = self.current_note {
                    if note.heading_text.is_empty() {
                        self.heading_target = Some(HeadingTarget::Note);
                        self.heading_buffer.clear();
                    }
                }
            } else if self.current_section.is_some() && parent_tag == Some("section") {
                self.heading_target = Some(HeadingTarget::Section);
                self.heading_buffer.clear();
            } else if !self.shared.level_stack.is_empty()
                && parent_tag
                    .map(|t| USC_LEVEL_HIERARCHY.contains(&t))
                    .unwrap_or(false)
            {
                self.heading_target = Some(HeadingTarget::Level);
                self.heading_buffer.clear();
            }
        }

        if self.current_section.is_none() {
            return;
        }

        if is_section_skip_tag(tag_name)
            || ((tag_name == "num" || tag_name == "heading") && parent_tag == Some("section"))
        {
            self.skip_depth += 1;
        }

        if tag_name == "num" {
            if let Some(val) = value {
                if let Some(ref mut section) = self.current_section {
                    if section.section_num.is_none() {
                        section.section_num = Some(strip_leading_zeros(val));
                    }
                }
            }
        }

        if tag_name == "sourceCredit" {
            self.source_credit_depth += 1;
            self.source_credit_buffer.clear();
        }

        if is_section_body_tag(tag_name) && self.skip_depth == 0 {
            self.body_capture_depth += 1;
            if self.body_capture_depth == 1 {
                self.body_buffer.clear();
            }
        }

        if tag_name == "heading"
            && parent_tag != Some("section")
            && self.skip_depth == 0
            && self.current_note.is_none()
            && self.shared.note_depth == 0
            && self.body_capture_depth > 0
        {
            self.body_heading_depth += 1;
            if self.body_heading_depth == 1 {
                self.body_heading_buffer.clear();
            }
        }

        if tag_name == "note" {
            self.current_note = Some(NoteFrame {
                topic: topic.unwrap_or("").to_string(),
                role: role.unwrap_or("").to_string(),
                heading_text: String::new(),
                p_parts: Vec::new(),
            });
        }

        if self.current_note.is_some() && tag_name == "p" {
            self.note_p_depth += 1;
            if self.note_p_depth == 1 {
                self.note_p_buffer.clear();
            }
        }
    }

    fn handle_text(&mut self, text: &str) {
        // Shared text
        if self.shared.meta_title_capture {
            self.shared.meta_title_buffer.push_str(text);
        }
        if self.heading_target.is_some() {
            self.heading_buffer.push_str(text);
        }
        if self.shared.num_depth > 0 {
            self.shared.num_buffer.push_str(text);
        }

        // Full-specific text
        if self.current_section.is_some()
            && self.body_capture_depth > 0
            && self.skip_depth == 0
            && self.body_heading_depth == 0
        {
            self.body_buffer.push_str(text);
        }

        if self.body_heading_depth > 0 {
            self.body_heading_buffer.push_str(text);
        }

        if self.source_credit_depth > 0 {
            self.source_credit_buffer.push_str(text);
        }

        if self.note_p_depth > 0 {
            self.note_p_buffer.push_str(text);
        }
    }

    fn handle_close(&mut self, tag_name: &str) {
        if tag_name == "section" && self.shared.ignored_section_depth > 0 {
            self.shared.ignored_section_depth -= 1;
            return;
        }

        if self.heading_target.is_some() && tag_name == "heading" {
            let mut heading = normalized_whitespace(&self.heading_buffer);
            match self.heading_target {
                Some(HeadingTarget::Note) => {
                    if let Some(ref mut note) = self.current_note {
                        note.heading_text = heading;
                    }
                }
                Some(HeadingTarget::Section) => {
                    if let Some(ref mut section) = self.current_section {
                        if section.bracketed_num && heading.ends_with(']') {
                            heading = heading[..heading.len() - 1].trim().to_string();
                        }
                        section.heading = heading;
                    }
                }
                Some(HeadingTarget::Level) => {
                    if let Some(idx) = self.shared.level_stack.len().checked_sub(1) {
                        let frame = &mut self.shared.level_stack[idx];
                        if frame.bracketed_num && heading.ends_with(']') {
                            heading = heading[..heading.len() - 1].trim().to_string();
                        }
                        frame.heading = heading;
                        // release the mutable borrow before calling emit_level_if_ready
                        self.emit_level_if_ready(idx);
                    }
                }
                None => {}
            }
            self.heading_target = None;
            self.heading_buffer.clear();
        }

        if self.body_heading_depth > 0 && tag_name == "heading" {
            self.body_heading_depth -= 1;
            if self.body_heading_depth == 0 {
                let heading = normalized_whitespace(&self.body_heading_buffer);
                if !heading.is_empty() {
                    let heading_line = format!("**{heading}**");
                    if !self.body_buffer.is_empty()
                        && !self.body_buffer.ends_with(char::is_whitespace)
                    {
                        self.body_buffer.push(' ');
                    }
                    self.body_buffer.push_str(&heading_line);
                    self.body_buffer.push_str("\n\n");
                }
                self.body_heading_buffer.clear();
            }
        }

        if self.current_section.is_some()
            && self.skip_depth > 0
            && (is_section_skip_tag(tag_name)
                || ((tag_name == "num" || tag_name == "heading")
                    && self.shared.tag_stack.last().map(|s| s.as_str()) == Some("section")))
        {
            self.skip_depth = self.skip_depth.saturating_sub(1);
        }

        if self.current_section.is_some() && is_section_body_tag(tag_name) && self.skip_depth == 0 && self.body_capture_depth > 0 {
            self.body_capture_depth -= 1;
            if self.body_capture_depth == 0 {
                let text = self.body_buffer.trim().to_string();
                if !text.is_empty() {
                    if let Some(ref mut section) = self.current_section {
                        section.body_parts.push(text);
                    }
                }
                self.body_buffer.clear();
            }
        }

        if tag_name == "sourceCredit" {
            self.source_credit_depth = self.source_credit_depth.saturating_sub(1);
            if self.source_credit_depth == 0 {
                if let Some(ref mut section) = self.current_section {
                    section.history_short = normalized_whitespace(&self.source_credit_buffer);
                }
                self.source_credit_buffer.clear();
            }
        }

        if self.current_note.is_some() && tag_name == "p" && self.note_p_depth > 0 {
            self.note_p_depth -= 1;
            if self.note_p_depth == 0 {
                let text = normalized_whitespace(&self.note_p_buffer);
                if !text.is_empty() {
                    if let Some(ref mut note) = self.current_note {
                        note.p_parts.push(text);
                    }
                }
                self.note_p_buffer.clear();
            }
        }

        if self.current_note.is_some() && tag_name == "note" {
            let note = self.current_note.take().unwrap();
            let heading = &note.heading_text;
            let body = normalized_whitespace(&note.p_parts.join("\n\n"));
            let final_body = if body.is_empty() {
                heading.clone()
            } else {
                body
            };

            if let Some(ref mut section) = self.current_section {
                if !final_body.is_empty() || !note.topic.is_empty() {
                    if note.topic == "amendments"
                        || heading.to_lowercase().contains("amendments")
                    {
                        if !final_body.is_empty() {
                            section.history_long_parts.push(final_body);
                        }
                    } else if note.role.contains("crossHeading")
                        || heading.contains("Editorial")
                        || heading.contains("Statutory")
                    {
                        // Skip editorial/statutory notes
                    } else if !final_body.is_empty() {
                        section.citations_parts.push(CitationEntry {
                            heading: heading.clone(),
                            body: final_body,
                        });
                    }
                }
            }
        }

        if tag_name == "section" && self.current_section.is_some() {
            self.close_full_section();
        }

        // Shared close
        if tag_name == "meta" {
            self.shared.meta_depth = self.shared.meta_depth.saturating_sub(1);
        }

        if self.shared.meta_title_capture && tag_name == "title" && self.shared.meta_depth > 0 {
            let candidate = self.shared.meta_title_buffer.trim().to_string();
            if !candidate.is_empty() {
                self.shared.title_name = candidate;
            }
            self.shared.meta_title_capture = false;
            self.shared.meta_title_buffer.clear();
        }

        if tag_name == "num" {
            self.close_num_target();
        }

        if tag_name == "note" {
            self.shared.note_depth = self.shared.note_depth.saturating_sub(1);
        }

        if tag_name == "quotedContent" {
            self.shared.quoted_content_depth = self.shared.quoted_content_depth.saturating_sub(1);
        }

        if is_usc_level(tag_name) {
            if let Some(idx) = self.shared.level_stack.len().checked_sub(1) {
                self.emit_level_if_ready(idx);
                self.shared.level_stack.pop();
            }
        }
    }

    fn close_full_section(&mut self) {
        let section = match self.current_section.take() {
            Some(s) => s,
            None => return,
        };

        let section_num = match section.section_num {
            Some(ref num) => num.clone(),
            None => return,
        };

        let section_key = format!("{}-{}", self.shared.title_num, section_num);
        let count = self.shared.section_counts.entry(section_key).or_insert(0);
        *count += 1;
        let final_section_num = if *count == 1 {
            section_num
        } else {
            format!("{}-{}", section_num, count)
        };

        let body = normalized_whitespace(&section.body_parts.join("\n\n"));
        let history_long = section.history_long_parts.join("\n\n");
        let citations = section
            .citations_parts
            .iter()
            .filter(|e| !e.body.is_empty())
            .map(|e| {
                if e.heading.is_empty() {
                    e.body.clone()
                } else {
                    format!("{}\n{}", e.heading, e.body)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
            .trim()
            .to_string();

        self.events.push(USCStreamEvent::Section(USCSection {
            section_key: format!("{}:{}", self.shared.title_num, final_section_num),
            title_num: self.shared.title_num.clone(),
            section_num: final_section_num.clone(),
            heading: section.heading,
            body,
            history_short: section.history_short,
            history_long,
            citations,
            path: format!(
                "/statutes/usc/section/{}/{}",
                self.shared.title_num, final_section_num
            ),
            doc_id: format!("doc_usc_{}-{}", self.shared.title_num, final_section_num),
            parent_ref: section.parent_ref,
        }));
    }

    fn drain_events(&mut self) -> Vec<USCStreamEvent> {
        std::mem::take(&mut self.events)
    }
}

// ─── Public API ────────────────────────────────────────────

/// Parse USC structure XML (levels + section refs, no content).
pub fn parse_usc_structure_xml(
    xml: &str,
    file_title: &str,
    _source_url: &str,
) -> (Vec<USCStructureEvent>, String, String) {
    let mut parser = StructureParser::new(file_title);
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);
                let parent_tag = parser.shared.tag_stack.last().cloned();
                parser.shared.tag_stack.push(tag_name.clone());
                parser.handle_open(&tag_name, parent_tag.as_deref(), &attrs);
            }
            Ok(Event::Empty(ref e)) => {
                // Self-closing tag: fire open + close
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);
                let parent_tag = parser.shared.tag_stack.last().cloned();
                parser.shared.tag_stack.push(tag_name.clone());
                parser.handle_open(&tag_name, parent_tag.as_deref(), &attrs);
                parser.shared.tag_stack.pop();
                parser.handle_close(&tag_name);
            }
            Ok(Event::End(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                parser.shared.tag_stack.pop();
                parser.handle_close(&tag_name);
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    parser.handle_text(&text);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                tracing::warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    let events = parser.drain_events();
    let title_num = parser.shared.title_num.clone();
    let title_name = if parser.shared.title_name.is_empty() {
        format!("Title {}", title_num)
    } else {
        parser.shared.title_name.clone()
    };
    (events, title_num, title_name)
}

/// Parse USC XML with full section content.
pub fn parse_usc_full_xml(
    xml: &str,
    file_title: &str,
    _source_url: &str,
) -> (Vec<USCStreamEvent>, String, String) {
    let mut parser = FullParser::new(file_title);
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);
                let parent_tag = parser.shared.tag_stack.last().cloned();
                parser.shared.tag_stack.push(tag_name.clone());
                parser.handle_open(&tag_name, parent_tag.as_deref(), &attrs);
            }
            Ok(Event::Empty(ref e)) => {
                // Self-closing tag: fire open + close
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);
                let parent_tag = parser.shared.tag_stack.last().cloned();
                parser.shared.tag_stack.push(tag_name.clone());
                parser.handle_open(&tag_name, parent_tag.as_deref(), &attrs);
                parser.shared.tag_stack.pop();
                parser.handle_close(&tag_name);
            }
            Ok(Event::End(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                parser.shared.tag_stack.pop();
                parser.handle_close(&tag_name);
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    parser.handle_text(&text);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                tracing::warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    let events = parser.drain_events();
    let title_num = parser.shared.title_num.clone();
    let title_name = if parser.shared.title_name.is_empty() {
        format!("Title {}", title_num)
    } else {
        parser.shared.title_name.clone()
    };
    (events, title_num, title_name)
}

/// Convenience: parse USC XML and return structured result.
pub fn parse_usc_xml(xml: &str, file_title: &str, source_url: &str) -> ParseResult {
    let (events, title_num, title_name) = parse_usc_full_xml(xml, file_title, source_url);
    let mut sections = Vec::new();
    let mut levels = Vec::new();

    for event in events {
        match event {
            USCStreamEvent::Section(s) => sections.push(s),
            USCStreamEvent::Level(l) => levels.push(l),
            USCStreamEvent::Title { .. } => {}
        }
    }

    ParseResult {
        sections,
        levels,
        title_num,
        title_name,
    }
}

/// Parse structure XML and return only section content (USCSection) events.
/// Used by the container to stream section content from chunks.
pub fn parse_usc_section_content_xml(
    xml: &str,
    file_title: &str,
    source_url: &str,
) -> Vec<USCSection> {
    let (events, _, _) = parse_usc_full_xml(xml, file_title, source_url);
    events
        .into_iter()
        .filter_map(|e| match e {
            USCStreamEvent::Section(s) => Some(s),
            _ => None,
        })
        .collect()
}

/// Parse structure XML and return only structure events (levels + section refs).
/// Used by the container to stream structure from chunks.
pub fn parse_usc_structure_events(
    xml: &str,
    file_title: &str,
    source_url: &str,
) -> Vec<USCStructureEvent> {
    let (events, _, _) = parse_usc_structure_xml(xml, file_title, source_url);
    events
}

/// Sort key for section numbers.
pub fn section_sort_key(section_num: &str) -> (u8, SortValue) {
    let lower = section_num.to_lowercase();
    let re = regex::Regex::new(r"^(\d+)([a-z]*)$").unwrap();
    match re.captures(&lower) {
        Some(caps) => {
            let n: i64 = caps[1].parse().unwrap_or(0);
            let suffix = caps[2].to_string();
            (1, SortValue::Numeric(n, suffix))
        }
        None => (0, SortValue::String(lower)),
    }
}

/// Sort key for title numbers.
pub fn title_sort_key(t: &str) -> (u8, SortValue) {
    section_sort_key(t)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SortValue {
    String(String),
    Numeric(i64, String),
}

// ─── Internal helpers ──────────────────────────────────────

fn extract_attrs(e: &quick_xml::events::BytesStart) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    for attr in e.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
        let val = String::from_utf8_lossy(&attr.value).to_string();
        attrs.insert(key, val);
    }
    attrs
}
