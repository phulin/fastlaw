use quick_xml::events::{BytesStart, Event};
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
    pub parent_ref: USCParentRef,
}

#[derive(Debug, Clone)]
pub enum USCParentRef {
    Title { title_num: String },
    Level { level_type: String, identifier: String },
}

#[derive(Debug, Clone)]
pub enum USCStreamEvent {
    Level(USCLevel),
    Section(USCSection),
}

pub struct ParseResult {
    pub sections: Vec<USCSection>,
    pub levels: Vec<USCLevel>,
    pub title_num: String,
    pub title_name: String,
}

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
        return value.to_string();
    }

    for c in chars {
        if c.is_ascii_alphabetic() {
            suffix.push(c.to_ascii_lowercase());
        } else {
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
        if !num_part.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
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
struct NoteFrame {
    topic: String,
    role: String,
    heading_text: String,
    p_parts: Vec<String>,
}

#[derive(Debug, Clone)]
struct CitationEntry {
    heading: String,
    body: String,
}

#[derive(Debug, Clone)]
struct SectionBuilder {
    section_num: Option<String>,
    heading: String,
    body_parts: Vec<String>,
    history_short: String,
    history_long_parts: Vec<String>,
    citations_parts: Vec<CitationEntry>,
    parent_ref: USCParentRef,
    bracketed_num: bool,
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

#[derive(Debug, Clone)]
struct DocContext {
    tag_stack: Vec<String>,
    level_stack: Vec<LevelFrame>,
    title_num: String,
    title_name: String,
    meta_depth: usize,
    meta_title_capture: bool,
    meta_title_buffer: String,
    note_depth: usize,
    quoted_content_depth: usize,
}

impl DocContext {
    fn new(file_title: &str) -> Self {
        Self {
            tag_stack: Vec::new(),
            level_stack: Vec::new(),
            title_num: file_title.to_string(),
            title_name: String::new(),
            meta_depth: 0,
            meta_title_capture: false,
            meta_title_buffer: String::new(),
            note_depth: 0,
            quoted_content_depth: 0,
        }
    }

    fn ensure_title_num(&mut self, attrs: &HashMap<String, String>) {
        if let Some(ident) = attrs.get("identifier") {
            if let Some(parsed) = parse_title_from_identifier(ident) {
                self.title_num = parsed;
            }
        }
    }

    fn open_shared(&mut self, tag_name: &str, attrs: &HashMap<String, String>) {
        self.ensure_title_num(attrs);

        if tag_name == "meta" {
            self.meta_depth += 1;
        }

        if self.meta_depth > 0 && tag_name == "title" {
            self.meta_title_capture = true;
            self.meta_title_buffer.clear();
        }

        if tag_name == "note" {
            self.note_depth += 1;
        }

        if tag_name == "quotedContent" {
            self.quoted_content_depth += 1;
        }

        if is_usc_level(tag_name) {
            let identifier = attrs.get("identifier").map(|s| s.as_str());
            let level_num = identifier.and_then(|id| parse_level_num_from_identifier(id, tag_name));
            let parent_identifier = if self.level_stack.is_empty() {
                Some(format!("{}-title", self.title_num))
            } else {
                self.level_stack.last().and_then(|f| f.identifier.clone())
            };

            let computed_identifier = level_num.as_ref().map(|num| {
                format!("{}-{}{}", self.title_num, level_id_prefix(tag_name), num)
            });

            self.level_stack.push(LevelFrame {
                level_type: tag_name.to_string(),
                num: level_num,
                identifier: computed_identifier,
                heading: String::new(),
                parent_identifier,
                emitted: false,
                bracketed_num: false,
            });
        }
    }

    fn text_shared(&mut self, text: &str) {
        if self.meta_title_capture {
            self.meta_title_buffer.push_str(text);
        }
    }

    fn close_shared(&mut self, tag_name: &str) {
        if tag_name == "meta" {
            self.meta_depth = self.meta_depth.saturating_sub(1);
        }

        if self.meta_title_capture && tag_name == "title" && self.meta_depth > 0 {
            let candidate = self.meta_title_buffer.trim().to_string();
            if !candidate.is_empty() {
                self.title_name = candidate;
            }
            self.meta_title_capture = false;
            self.meta_title_buffer.clear();
        }

        if tag_name == "note" {
            self.note_depth = self.note_depth.saturating_sub(1);
        }

        if tag_name == "quotedContent" {
            self.quoted_content_depth = self.quoted_content_depth.saturating_sub(1);
        }
    }

    fn parse_section_parent_ref(&self) -> USCParentRef {
        if let Some(parent_level) = self.level_stack.last() {
            if let Some(ref identifier) = parent_level.identifier {
                return USCParentRef::Level {
                    level_type: parent_level.level_type.clone(),
                    identifier: identifier.clone(),
                };
            }
        }

        USCParentRef::Title {
            title_num: self.title_num.clone(),
        }
    }
}

struct StructureSaxParser {
    ctx: DocContext,
    levels: Vec<USCLevel>,
    heading_target: Option<HeadingTarget>,
    heading_buffer: String,
    num_depth: usize,
    num_buffer: String,
    num_target: Option<NumTarget>,
}

impl StructureSaxParser {
    fn new(file_title: &str) -> Self {
        Self {
            ctx: DocContext::new(file_title),
            levels: Vec::new(),
            heading_target: None,
            heading_buffer: String::new(),
            num_depth: 0,
            num_buffer: String::new(),
            num_target: None,
        }
    }

    fn open(&mut self, tag_name: &str, parent_tag: Option<&str>, attrs: &HashMap<String, String>) {
        self.ctx.open_shared(tag_name, attrs);

        if tag_name == "heading"
            && !self.ctx.level_stack.is_empty()
            && parent_tag
                .map(|tag| USC_LEVEL_HIERARCHY.contains(&tag))
                .unwrap_or(false)
        {
            self.heading_target = Some(HeadingTarget::Level);
            self.heading_buffer.clear();
        }

        if tag_name == "num" {
            self.num_depth += 1;
            if self.num_depth == 1 {
                self.num_buffer.clear();
                self.num_target = if !self.ctx.level_stack.is_empty() {
                    Some(NumTarget::Level)
                } else {
                    None
                };
            }
        }
    }

    fn text(&mut self, text: &str) {
        self.ctx.text_shared(text);

        if self.heading_target.is_some() {
            self.heading_buffer.push_str(text);
        }

        if self.num_depth > 0 {
            self.num_buffer.push_str(text);
        }
    }

    fn ensure_level_identifier(&mut self, index: usize) {
        let frame = &mut self.ctx.level_stack[index];
        if frame.identifier.is_none() && frame.num.is_some() {
            frame.identifier = Some(format!(
                "{}-{}{}",
                self.ctx.title_num,
                level_id_prefix(&frame.level_type),
                frame.num.as_ref().expect("num must exist for identifier")
            ));
        }
    }

    fn emit_level_if_ready(&mut self, index: usize) {
        self.ensure_level_identifier(index);

        let frame = &mut self.ctx.level_stack[index];
        if frame.emitted || frame.identifier.is_none() || frame.num.is_none() {
            return;
        }

        self.levels.push(USCLevel {
            level_type: frame.level_type.clone(),
            level_index: usc_level_index(&frame.level_type).expect("level_type must be valid USC level"),
            identifier: frame.identifier.clone().expect("identifier must be present"),
            num: frame.num.clone().expect("num must be present"),
            heading: frame.heading.clone(),
            title_num: self.ctx.title_num.clone(),
            parent_identifier: frame.parent_identifier.clone(),
        });
        frame.emitted = true;
    }

    fn close_num_target(&mut self) {
        if self.num_depth == 0 {
            return;
        }

        self.num_depth -= 1;
        if self.num_depth > 0 {
            return;
        }

        if self.num_buffer.trim().starts_with('[') && self.num_target == Some(NumTarget::Level) {
            if let Some(frame) = self.ctx.level_stack.last_mut() {
                frame.bracketed_num = true;
            }
        }

        self.num_buffer.clear();
        self.num_target = None;
    }

    fn close(&mut self, tag_name: &str) {
        if self.heading_target.is_some() && tag_name == "heading" {
            let mut heading = normalized_whitespace(&self.heading_buffer);
            if let Some(idx) = self.ctx.level_stack.len().checked_sub(1) {
                let frame = &mut self.ctx.level_stack[idx];
                if frame.bracketed_num && heading.ends_with(']') {
                    heading = heading[..heading.len() - 1].trim().to_string();
                }
                frame.heading = heading;
                self.emit_level_if_ready(idx);
            }
            self.heading_target = None;
            self.heading_buffer.clear();
        }

        if tag_name == "num" {
            self.close_num_target();
        }

        if is_usc_level(tag_name) {
            if let Some(idx) = self.ctx.level_stack.len().checked_sub(1) {
                self.emit_level_if_ready(idx);
                self.ctx.level_stack.pop();
            }
        }

        self.ctx.close_shared(tag_name);
    }

    fn parse_events(mut self, events: &[SaxEvent]) -> (Vec<USCLevel>, String, String) {
        for event in events {
            match event {
                SaxEvent::Open {
                    tag_name,
                    parent_tag,
                    attrs,
                } => {
                    self.ctx.tag_stack.push(tag_name.clone());
                    self.open(tag_name, parent_tag.as_deref(), attrs);
                }
                SaxEvent::Close { tag_name } => {
                    self.ctx.tag_stack.pop();
                    self.close(tag_name);
                }
                SaxEvent::Text(text) => self.text(text),
            }
        }

        let title_num = self.ctx.title_num.clone();
        let title_name = if self.ctx.title_name.is_empty() {
            format!("Title {}", title_num)
        } else {
            self.ctx.title_name.clone()
        };

        (self.levels, title_num, title_name)
    }
}

struct SectionContentSaxParser {
    ctx: DocContext,
    sections: Vec<USCSection>,
    section_counts: HashMap<String, usize>,
    current_section: Option<SectionBuilder>,
    current_note: Option<NoteFrame>,
    heading_target: Option<HeadingTarget>,
    heading_buffer: String,
    num_depth: usize,
    num_buffer: String,
    num_target: Option<NumTarget>,
    skip_depth: usize,
    body_capture_depth: usize,
    body_buffer: String,
    source_credit_depth: usize,
    source_credit_buffer: String,
    note_p_depth: usize,
    note_p_buffer: String,
    body_heading_depth: usize,
    body_heading_buffer: String,
    ignored_section_depth: usize,
}

impl SectionContentSaxParser {
    fn new(file_title: &str) -> Self {
        Self {
            ctx: DocContext::new(file_title),
            sections: Vec::new(),
            section_counts: HashMap::new(),
            current_section: None,
            current_note: None,
            heading_target: None,
            heading_buffer: String::new(),
            num_depth: 0,
            num_buffer: String::new(),
            num_target: None,
            skip_depth: 0,
            body_capture_depth: 0,
            body_buffer: String::new(),
            source_credit_depth: 0,
            source_credit_buffer: String::new(),
            note_p_depth: 0,
            note_p_buffer: String::new(),
            body_heading_depth: 0,
            body_heading_buffer: String::new(),
            ignored_section_depth: 0,
        }
    }

    fn open(&mut self, tag_name: &str, parent_tag: Option<&str>, attrs: &HashMap<String, String>) {
        self.ctx.open_shared(tag_name, attrs);

        let identifier = attrs.get("identifier").map(|s| s.as_str());
        let value = attrs.get("value").map(|s| s.as_str());
        let topic = attrs.get("topic").map(|s| s.as_str());
        let role = attrs.get("role").map(|s| s.as_str());

        if tag_name == "section" {
            if self.ctx.note_depth > 0 || self.ctx.quoted_content_depth > 0 {
                self.ignored_section_depth += 1;
                return;
            }

            self.current_section = Some(SectionBuilder {
                section_num: identifier.and_then(parse_section_from_identifier),
                heading: String::new(),
                body_parts: Vec::new(),
                history_short: String::new(),
                history_long_parts: Vec::new(),
                citations_parts: Vec::new(),
                parent_ref: self.ctx.parse_section_parent_ref(),
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
            } else if !self.ctx.level_stack.is_empty()
                && parent_tag
                    .map(|tag| USC_LEVEL_HIERARCHY.contains(&tag))
                    .unwrap_or(false)
            {
                self.heading_target = Some(HeadingTarget::Level);
                self.heading_buffer.clear();
            }
        }

        if tag_name == "num" {
            self.num_depth += 1;
            if self.num_depth == 1 {
                self.num_buffer.clear();
                if self.current_section.is_some() {
                    self.num_target = Some(NumTarget::Section);
                } else if !self.ctx.level_stack.is_empty() {
                    self.num_target = Some(NumTarget::Level);
                } else {
                    self.num_target = None;
                }
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
            if let Some(raw_value) = value {
                if let Some(ref mut section) = self.current_section {
                    if section.section_num.is_none() {
                        section.section_num = Some(strip_leading_zeros(raw_value));
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
            && self.ctx.note_depth == 0
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

    fn text(&mut self, text: &str) {
        self.ctx.text_shared(text);

        if self.heading_target.is_some() {
            self.heading_buffer.push_str(text);
        }

        if self.num_depth > 0 {
            self.num_buffer.push_str(text);
        }

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

    fn close_num_target(&mut self) {
        if self.num_depth == 0 {
            return;
        }

        self.num_depth -= 1;
        if self.num_depth > 0 {
            return;
        }

        let text = self.num_buffer.trim();
        if text.starts_with('[') {
            match self.num_target {
                Some(NumTarget::Section) => {
                    if let Some(ref mut section) = self.current_section {
                        section.bracketed_num = true;
                    }
                }
                Some(NumTarget::Level) => {
                    if let Some(frame) = self.ctx.level_stack.last_mut() {
                        frame.bracketed_num = true;
                    }
                }
                None => {}
            }
        }

        self.num_buffer.clear();
        self.num_target = None;
    }

    fn close_current_section(&mut self) {
        let section = match self.current_section.take() {
            Some(section) => section,
            None => return,
        };

        let section_num = match section.section_num {
            Some(num) => num,
            None => return,
        };

        let section_key = format!("{}-{}", self.ctx.title_num, section_num);
        let count = self.section_counts.entry(section_key).or_insert(0);
        *count += 1;
        let final_section_num = if *count == 1 {
            section_num
        } else {
            format!("{}-{}", section_num, count)
        };

        let citations = section
            .citations_parts
            .iter()
            .filter(|entry| !entry.body.is_empty())
            .map(|entry| {
                if entry.heading.is_empty() {
                    entry.body.clone()
                } else {
                    format!("{}\n{}", entry.heading, entry.body)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
            .trim()
            .to_string();

        self.sections.push(USCSection {
            section_key: format!("{}:{}", self.ctx.title_num, final_section_num),
            title_num: self.ctx.title_num.clone(),
            section_num: final_section_num.clone(),
            heading: section.heading,
            body: normalized_whitespace(&section.body_parts.join("\n\n")),
            history_short: section.history_short,
            history_long: section.history_long_parts.join("\n\n"),
            citations,
            path: format!(
                "/statutes/usc/section/{}/{}",
                self.ctx.title_num, final_section_num
            ),
            parent_ref: section.parent_ref,
        });
    }

    fn close(&mut self, tag_name: &str) {
        if tag_name == "section" && self.ignored_section_depth > 0 {
            self.ignored_section_depth -= 1;
            self.ctx.close_shared(tag_name);
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
                    if let Some(frame) = self.ctx.level_stack.last_mut() {
                        if frame.bracketed_num && heading.ends_with(']') {
                            heading = heading[..heading.len() - 1].trim().to_string();
                        }
                        frame.heading = heading;
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
                    if !self.body_buffer.is_empty() && !self.body_buffer.ends_with(char::is_whitespace)
                    {
                        self.body_buffer.push(' ');
                    }
                    self.body_buffer.push_str(&format!("**{heading}**\n\n"));
                }
                self.body_heading_buffer.clear();
            }
        }

        if self.current_section.is_some()
            && self.skip_depth > 0
            && (is_section_skip_tag(tag_name)
                || ((tag_name == "num" || tag_name == "heading")
                    && self.ctx.tag_stack.last().map(|s| s.as_str()) == Some("section")))
        {
            self.skip_depth = self.skip_depth.saturating_sub(1);
        }

        if self.current_section.is_some()
            && is_section_body_tag(tag_name)
            && self.skip_depth == 0
            && self.body_capture_depth > 0
        {
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
            let note = self.current_note.take().expect("note should exist");
            let heading = &note.heading_text;
            let body = normalized_whitespace(&note.p_parts.join("\n\n"));
            let final_body = if body.is_empty() {
                heading.clone()
            } else {
                body
            };

            if let Some(ref mut section) = self.current_section {
                if !final_body.is_empty() || !note.topic.is_empty() {
                    if note.topic == "amendments" || heading.to_lowercase().contains("amendments") {
                        if !final_body.is_empty() {
                            section.history_long_parts.push(final_body);
                        }
                    } else if note.role.contains("crossHeading")
                        || heading.contains("Editorial")
                        || heading.contains("Statutory")
                    {
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
            self.close_current_section();
        }

        if tag_name == "num" {
            self.close_num_target();
        }

        if is_usc_level(tag_name) {
            self.ctx.level_stack.pop();
        }

        self.ctx.close_shared(tag_name);
    }

    fn parse_events(mut self, events: &[SaxEvent]) -> (Vec<USCSection>, String, String) {
        for event in events {
            match event {
                SaxEvent::Open {
                    tag_name,
                    parent_tag,
                    attrs,
                } => {
                    self.ctx.tag_stack.push(tag_name.clone());
                    self.open(tag_name, parent_tag.as_deref(), attrs);
                }
                SaxEvent::Close { tag_name } => {
                    self.ctx.tag_stack.pop();
                    self.close(tag_name);
                }
                SaxEvent::Text(text) => self.text(text),
            }
        }

        let title_num = self.ctx.title_num.clone();
        let title_name = if self.ctx.title_name.is_empty() {
            format!("Title {}", title_num)
        } else {
            self.ctx.title_name.clone()
        };

        (self.sections, title_num, title_name)
    }
}

enum SaxEvent {
    Open {
        tag_name: String,
        parent_tag: Option<String>,
        attrs: HashMap<String, String>,
    },
    Close {
        tag_name: String,
    },
    Text(String),
}

fn collect_sax_events(xml: &str) -> Vec<SaxEvent> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut tag_stack: Vec<String> = Vec::new();
    let mut events = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);
                let parent_tag = tag_stack.last().cloned();
                events.push(SaxEvent::Open {
                    tag_name: tag_name.clone(),
                    parent_tag,
                    attrs,
                });
                tag_stack.push(tag_name.clone());
            }
            Ok(Event::Empty(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                let attrs = extract_attrs(e);
                let parent_tag = tag_stack.last().cloned();
                events.push(SaxEvent::Open {
                    tag_name: tag_name.clone(),
                    parent_tag,
                    attrs,
                });
                events.push(SaxEvent::Close {
                    tag_name: tag_name.clone(),
                });
                tag_stack.push(tag_name.clone());
                tag_stack.pop();
            }
            Ok(Event::End(ref e)) => {
                let raw_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let tag_name = normalize_tag_name(&raw_name).to_string();
                tag_stack.pop();
                events.push(SaxEvent::Close { tag_name });
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    events.push(SaxEvent::Text(text.to_string()));
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

    events
}

pub fn parse_usc_full_xml(
    xml: &str,
    file_title: &str,
    _source_url: &str,
) -> (Vec<USCStreamEvent>, String, String) {
    let events = collect_sax_events(xml);

    let structure = StructureSaxParser::new(file_title);
    let (levels, title_num_from_levels, title_name_from_levels) = structure.parse_events(&events);

    let content = SectionContentSaxParser::new(file_title);
    let (sections, title_num_from_sections, title_name_from_sections) =
        content.parse_events(&events);

    let title_num = if !title_num_from_sections.is_empty() {
        title_num_from_sections
    } else {
        title_num_from_levels
    };

    let title_name = if title_name_from_sections.starts_with("Title ")
        && !title_name_from_levels.starts_with("Title ")
    {
        title_name_from_levels
    } else {
        title_name_from_sections
    };

    let mut events = Vec::with_capacity(levels.len() + sections.len());
    events.extend(levels.into_iter().map(USCStreamEvent::Level));
    events.extend(sections.into_iter().map(USCStreamEvent::Section));

    (events, title_num, title_name)
}

pub fn parse_usc_xml(xml: &str, file_title: &str, source_url: &str) -> ParseResult {
    let (events, title_num, title_name) = parse_usc_full_xml(xml, file_title, source_url);
    let mut sections = Vec::new();
    let mut levels = Vec::new();

    for event in events {
        match event {
            USCStreamEvent::Section(section) => sections.push(section),
            USCStreamEvent::Level(level) => levels.push(level),
        }
    }

    ParseResult {
        sections,
        levels,
        title_num,
        title_name,
    }
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
