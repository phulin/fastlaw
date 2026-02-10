use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use std::collections::HashMap;

use crate::xmlspec::Engine;

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

pub fn usc_level_index(level_type: &str) -> Option<usize> {
    USC_LEVEL_HIERARCHY.iter().position(|&l| l == level_type)
}

pub fn section_level_index() -> usize {
    USC_LEVEL_HIERARCHY.len()
}

pub fn title_sort_key(title_num: &str) -> (i32, String) {
    let re = Regex::new(r"^(\d+)([a-zA-Z]?)$").expect("regex is valid");
    if let Some(caps) = re.captures(title_num) {
        let n: i32 = caps[1].parse().unwrap_or(0);
        let suffix = caps[2].to_lowercase();
        (n, suffix)
    } else {
        (0, title_num.to_string())
    }
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
    pub path: String,
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
        path: String,
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

crate::xmlspec! {
    schema UscSchema {
        record MainTitle
        from tag("title")
        where parent("main")
        {
            heading: first_text(child("heading")),
        }

        record MetaTitle
        from tag("meta")
        {
            title: first_text(child("title")),
        }

        record SubtitleLevel
        from tag("subtitle")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record PartLevel
        from tag("part")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record SubpartLevel
        from tag("subpart")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record ChapterLevel
        from tag("chapter")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record SubchapterLevel
        from tag("subchapter")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record DivisionLevel
        from tag("division")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record SubdivisionLevel
        from tag("subdivision")
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            heading: first_text(child("heading")),
        }

        record SectionBase
        from tag("section")
        where not(ancestor("note")) and not(ancestor("quotedContent"))
        {
            identifier: attr("identifier"),
            num: first_text(child("num")),
            num_value: attr(child("num"), "value"),
            heading: first_text(child("heading")),
            body_raw: text(
                desc("p"),
                except(desc("note"), desc("sourceCredit"), desc("quotedContent"))
            ),
            source_credit_raw: text(child("sourceCredit")),
            notes_raw: text(desc("note"), except(desc("quotedContent"))),
        }
    }
}

#[derive(Debug, Clone)]
struct RawLevel {
    level_type: &'static str,
    raw_identifier: Option<String>,
    num: String,
    heading: String,
}

#[derive(Debug, Clone)]
struct RawSection {
    raw_identifier: Option<String>,
    section_num: String,
    heading: String,
    body_raw: Option<String>,
    source_credit_raw: Option<String>,
    notes_raw: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SectionDetails {
    source_credit: String,
    body_parts: Vec<String>,
    amendments_parts: Vec<String>,
    note_parts: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct NoteBuilder {
    topic: String,
    role: String,
    heading: String,
    paragraphs: Vec<String>,
}

#[derive(Debug, Clone)]
struct LevelResolved {
    raw_identifier: Option<String>,
    level: USCLevel,
}

#[derive(Debug, Clone, Default)]
struct SectionScan {
    details: Vec<SectionDetails>,
    parent_level_raw_ids: Vec<Option<String>>,
}

fn level_id_prefix(level_type: &str) -> &'static str {
    match level_type {
        "title" => "t",
        "subtitle" => "st",
        "chapter" => "ch",
        "subchapter" => "sch",
        "part" => "pt",
        "subpart" => "spt",
        "division" => "d",
        "subdivision" => "sd",
        _ => "",
    }
}

fn is_usc_level_tag(tag: &str) -> bool {
    matches!(
        tag,
        "subtitle" | "part" | "subpart" | "chapter" | "subchapter" | "division" | "subdivision"
    )
}

fn parse_level_num_from_identifier(identifier: &str, level_type: &str) -> Option<String> {
    let rest = identifier.replace("/us/usc/", "");
    let rest = rest.trim_matches('/');
    let prefix = level_id_prefix(level_type);

    for part in rest.split('/') {
        if !part.starts_with(prefix) {
            continue;
        }
        let suffix = &part[prefix.len()..];
        if suffix.is_empty() {
            continue;
        }
        if suffix
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            return Some(strip_leading_zeros(suffix));
        }
    }
    None
}

fn parse_section_from_identifier(identifier: &str) -> Option<String> {
    let rest = identifier.replace("/us/usc/", "");
    let rest = rest.trim_matches('/');

    for part in rest.split('/').rev() {
        if part.starts_with('s') && part.as_bytes().get(1).is_some_and(|b| b.is_ascii_digit()) {
            return Some(strip_leading_zeros(&part[1..]));
        }
    }
    None
}

fn level_num_from_fields(
    level_type: &str,
    identifier: Option<&str>,
    num_text: Option<&str>,
) -> String {
    identifier
        .and_then(|id| parse_level_num_from_identifier(id, level_type))
        .or_else(|| num_text.and_then(extract_num_from_text))
        .unwrap_or_default()
}

fn raw_level(
    level_type: &'static str,
    identifier: Option<String>,
    num: Option<String>,
    heading: Option<String>,
) -> RawLevel {
    RawLevel {
        level_type,
        num: level_num_from_fields(level_type, identifier.as_deref(), num.as_deref()),
        heading: clean_heading(num.as_deref(), heading),
        raw_identifier: identifier,
    }
}

fn extract_num_from_text(text: &str) -> Option<String> {
    let trimmed = normalized_whitespace(text);
    if trimmed.is_empty() {
        return None;
    }

    if let Some(value) = trimmed.strip_prefix('§') {
        let token = value
            .trim()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('.');
        if !token.is_empty() {
            return Some(strip_leading_zeros(token));
        }
    }

    if let Some(last) = trimmed.split_whitespace().last() {
        let candidate = last.trim_matches(|c: char| {
            !c.is_ascii_alphanumeric() && c != '\u{2013}' && c != '\u{2014}'
        });
        if !candidate.is_empty() {
            return Some(strip_leading_zeros(candidate));
        }
    }

    Some(strip_leading_zeros(&trimmed))
}

fn clean_heading(num_text: Option<&str>, heading: Option<String>) -> String {
    let mut out = heading.unwrap_or_default();
    if num_text.is_some_and(|n| normalized_whitespace(n).starts_with('[')) && out.ends_with(']') {
        out.pop();
        out = out.trim().to_string();
    }
    out
}

fn resolve_levels(raw_levels: Vec<RawLevel>, title_num: &str) -> Vec<LevelResolved> {
    let mut resolved_by_index: Vec<Option<USCLevel>> = vec![None; raw_levels.len()];
    let mut sorted_indices = (0..raw_levels.len()).collect::<Vec<_>>();
    sorted_indices.sort_by_key(|idx| {
        raw_levels[*idx]
            .raw_identifier
            .as_ref()
            .map_or(usize::MAX, String::len)
    });

    for idx in sorted_indices {
        let raw = &raw_levels[idx];
        let parent_resolved = raw.raw_identifier.as_ref().and_then(|id| {
            let mut best_parent_idx: Option<usize> = None;
            for (candidate_idx, candidate_raw) in raw_levels.iter().enumerate() {
                let Some(candidate_id) = candidate_raw.raw_identifier.as_deref() else {
                    continue;
                };
                if candidate_idx == idx || candidate_id.len() >= id.len() {
                    continue;
                }
                if id.starts_with(candidate_id) {
                    match best_parent_idx {
                        Some(best) => {
                            let best_len = raw_levels[best]
                                .raw_identifier
                                .as_ref()
                                .map_or(0, String::len);
                            if candidate_id.len() > best_len {
                                best_parent_idx = Some(candidate_idx);
                            }
                        }
                        None => best_parent_idx = Some(candidate_idx),
                    }
                }
            }
            best_parent_idx.and_then(|parent_idx| resolved_by_index[parent_idx].clone())
        });

        let parent_identifier = parent_resolved
            .as_ref()
            .map(|p| p.identifier.clone())
            .or_else(|| Some(format!("{title_num}-title")));
        let parent_path = parent_resolved
            .as_ref()
            .map(|p| p.path.clone())
            .unwrap_or_else(|| format!("/statutes/usc/{title_num}"));

        let level = USCLevel {
            level_type: raw.level_type.to_string(),
            level_index: usc_level_index(raw.level_type).unwrap_or(0),
            identifier: format!(
                "{}/{}-{}",
                parent_identifier
                    .clone()
                    .expect("parent identifier is always present"),
                raw.level_type,
                raw.num
            ),
            num: raw.num.clone(),
            heading: raw.heading.clone(),
            title_num: title_num.to_string(),
            parent_identifier,
            path: format!("{parent_path}/{}-{}", raw.level_type, raw.num),
        };

        resolved_by_index[idx] = Some(level);
    }

    raw_levels
        .into_iter()
        .enumerate()
        .map(|(idx, raw)| LevelResolved {
            raw_identifier: raw.raw_identifier,
            level: resolved_by_index[idx]
                .clone()
                .expect("all levels should be resolved"),
        })
        .collect()
}

fn resolve_section_parent(
    parent_level_raw_hint: Option<&str>,
    section_raw_identifier: Option<&str>,
    levels: &[LevelResolved],
    title_num: &str,
) -> USCParentRef {
    if let Some(parent_raw) = parent_level_raw_hint {
        if let Some(level) = levels.iter().find_map(|resolved| {
            (resolved.raw_identifier.as_deref() == Some(parent_raw)).then_some(&resolved.level)
        }) {
            return USCParentRef::Level {
                level_type: level.level_type.clone(),
                identifier: level.identifier.clone(),
                path: level.path.clone(),
            };
        }
    }

    let Some(section_raw_identifier) = section_raw_identifier else {
        return USCParentRef::Title {
            title_num: title_num.to_string(),
        };
    };

    let mut best: Option<&USCLevel> = None;
    for resolved in levels {
        let Some(raw_id) = resolved.raw_identifier.as_deref() else {
            continue;
        };
        if section_raw_identifier.starts_with(raw_id) {
            match best {
                Some(existing) if existing.path.len() >= resolved.level.path.len() => {}
                _ => best = Some(&resolved.level),
            }
        }
    }

    if let Some(level) = best {
        USCParentRef::Level {
            level_type: level.level_type.clone(),
            identifier: level.identifier.clone(),
            path: level.path.clone(),
        }
    } else {
        USCParentRef::Title {
            title_num: title_num.to_string(),
        }
    }
}

fn parse_section_details(xml: &str) -> SectionScan {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut section_depths: Vec<usize> = Vec::new();
    let mut open_levels: Vec<Option<String>> = Vec::new();
    let mut details_by_depth: HashMap<usize, SectionDetails> = HashMap::new();
    let mut scan = SectionScan::default();

    let mut current_text = String::new();
    let mut skip_depth = 0usize;
    let mut in_inline_heading = false;
    let mut inline_heading_buffer = String::new();
    let mut current_note: Option<NoteBuilder> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = normalize_tag_name(String::from_utf8_lossy(e.name().as_ref()).as_ref())
                    .to_string();
                let parent = stack.last().map(String::as_str);

                if tag == "section" && !stack.iter().any(|t| t == "note" || t == "quotedContent") {
                    section_depths.push(stack.len() + 1);
                    details_by_depth.insert(stack.len() + 1, SectionDetails::default());
                    scan.parent_level_raw_ids
                        .push(open_levels.iter().rev().find_map(|raw| raw.clone()));
                    skip_depth = 0;
                    current_text.clear();
                }

                if is_usc_level_tag(&tag) {
                    let mut raw_identifier = None;
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"identifier" {
                            raw_identifier =
                                Some(String::from_utf8_lossy(attr.value.as_ref()).to_string());
                        }
                    }
                    open_levels.push(raw_identifier);
                }

                if let Some(section_depth) = section_depths.last().copied() {
                    if stack.len() + 1 >= section_depth {
                        if tag == "sourceCredit" {
                            current_text.clear();
                            skip_depth += 1;
                        }

                        if tag == "note" {
                            let mut topic = String::new();
                            let mut role = String::new();
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref());
                                let val = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                                if key == "topic" {
                                    topic = val;
                                } else if key == "role" {
                                    role = val;
                                }
                            }
                            current_note = Some(NoteBuilder {
                                topic,
                                role,
                                ..NoteBuilder::default()
                            });
                            skip_depth += 1;
                        }

                        if tag == "quotedContent" {
                            skip_depth += 1;
                        }

                        if is_section_body_tag(&tag) && skip_depth == 0 {
                            let text = current_text.trim().to_string();
                            if !text.is_empty() {
                                if let Some(details) = details_by_depth.get_mut(&section_depth) {
                                    details.body_parts.push(text);
                                }
                            }
                            current_text.clear();
                        }

                        if tag == "num" && parent == Some("section") {
                            current_text.clear();
                        }
                        if tag == "heading" && parent == Some("section") {
                            current_text.clear();
                        }

                        if tag == "num" && skip_depth == 0 && parent != Some("section") {
                            current_text.push_str("**");
                        }

                        if tag == "heading" && skip_depth == 0 && parent != Some("section") {
                            in_inline_heading = true;
                            inline_heading_buffer.clear();
                        }

                        if let Some(note) = current_note.as_ref() {
                            if !note.topic.is_empty() || !note.role.is_empty() {
                                if tag == "heading" || tag == "p" {
                                    current_text.clear();
                                }
                            }
                        }
                    }
                }

                stack.push(tag);
            }
            Ok(Event::Empty(ref e)) => {
                let tag = normalize_tag_name(String::from_utf8_lossy(e.name().as_ref()).as_ref())
                    .to_string();
                let parent = stack.last().cloned();
                stack.push(tag.clone());

                if let Some(section_depth) = section_depths.last().copied() {
                    if stack.len() >= section_depth && tag == "sourceCredit" {
                        if let Some(details) = details_by_depth.get_mut(&section_depth) {
                            details.source_credit = String::new();
                        }
                    }
                }

                if tag == "num" && parent.as_deref() != Some("section") {
                    current_text.push_str("****");
                }

                stack.pop();
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(unescaped) = e.unescape() {
                    let normalized = unescaped.replace('\n', " ").replace('\r', " ");
                    if in_inline_heading {
                        inline_heading_buffer.push_str(&normalized);
                    } else {
                        current_text.push_str(&normalized);
                    }
                }
            }
            Ok(Event::CData(ref e)) => {
                let normalized = String::from_utf8_lossy(e.as_ref())
                    .replace('\n', " ")
                    .replace('\r', " ");
                if in_inline_heading {
                    inline_heading_buffer.push_str(&normalized);
                } else {
                    current_text.push_str(&normalized);
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = normalize_tag_name(String::from_utf8_lossy(e.name().as_ref()).as_ref())
                    .to_string();
                let parent = stack
                    .len()
                    .checked_sub(2)
                    .and_then(|idx| stack.get(idx))
                    .map(String::as_str);

                if let Some(section_depth) = section_depths.last().copied() {
                    if stack.len() >= section_depth {
                        if tag == "sourceCredit" {
                            if let Some(details) = details_by_depth.get_mut(&section_depth) {
                                details.source_credit = normalized_whitespace(&current_text);
                            }
                            skip_depth = skip_depth.saturating_sub(1);
                            current_text.clear();
                        }

                        if is_section_body_tag(&tag) && skip_depth == 0 {
                            let text = current_text.trim().to_string();
                            if !text.is_empty() {
                                if let Some(details) = details_by_depth.get_mut(&section_depth) {
                                    details.body_parts.push(text);
                                }
                            }
                            current_text.clear();
                        }

                        if tag == "num" && skip_depth == 0 && parent != Some("section") {
                            current_text.push_str("**");
                        }

                        if tag == "heading" && skip_depth == 0 && parent != Some("section") {
                            let text = normalized_whitespace(&inline_heading_buffer);
                            in_inline_heading = false;
                            if !current_text.is_empty() && !current_text.ends_with(' ') {
                                current_text.push(' ');
                            }
                            current_text.push_str("**");
                            current_text.push_str(&text);
                            current_text.push_str("** ");
                        }

                        if let Some(note) = current_note.as_mut() {
                            if tag == "heading" {
                                note.heading = normalized_whitespace(&current_text);
                                current_text.clear();
                            } else if tag == "p" {
                                let text = normalized_whitespace(&current_text);
                                if !text.is_empty() {
                                    note.paragraphs.push(text);
                                }
                                current_text.clear();
                            }
                        }

                        if tag == "quotedContent" {
                            skip_depth = skip_depth.saturating_sub(1);
                        }

                        if tag == "note" {
                            skip_depth = skip_depth.saturating_sub(1);
                            if let Some(note) = current_note.take() {
                                if let Some(details) = details_by_depth.get_mut(&section_depth) {
                                    add_note_to_details(details, note);
                                }
                            }
                        }
                    }
                }

                if tag == "section" {
                    if let Some(depth) = section_depths.pop() {
                        if let Some(mut details) = details_by_depth.remove(&depth) {
                            let tail = current_text.trim().to_string();
                            if !tail.is_empty() {
                                details.body_parts.push(tail);
                                current_text.clear();
                            }
                            scan.details.push(details);
                        }
                    }
                    current_note = None;
                    in_inline_heading = false;
                    inline_heading_buffer.clear();
                    skip_depth = 0;
                }

                if is_usc_level_tag(&tag) {
                    open_levels.pop();
                }

                stack.pop();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    scan
}

fn add_note_to_details(details: &mut SectionDetails, note: NoteBuilder) {
    let body = normalized_whitespace(&note.paragraphs.join("\n\n"));
    let formatted = if body.is_empty() {
        note.heading.clone()
    } else if note.heading.is_empty() {
        body
    } else {
        format!("**{}**\n{}", note.heading, body)
    };

    if formatted.is_empty() && note.topic.is_empty() {
        return;
    }

    let heading_lower = note.heading.to_lowercase();
    if note.topic == "amendments" || heading_lower.contains("amendments") {
        if !formatted.is_empty() {
            details.amendments_parts.push(formatted);
        }
        return;
    }

    if note.role.contains("crossHeading")
        || note.heading.contains("Editorial")
        || note.heading.contains("Statutory")
    {
        return;
    }

    if !formatted.is_empty() {
        details.note_parts.push(formatted);
    }
}

fn collect_raw(
    xml: &str,
    file_title: &str,
) -> (
    String,
    Option<String>,
    Option<String>,
    Vec<RawLevel>,
    Vec<RawSection>,
) {
    // Stage 1: typed extraction via xmlspec. This stage only captures raw values.
    let mut title_main: Option<String> = None;
    let mut title_meta: Option<String> = None;
    let mut levels = Vec::new();
    let mut sections = Vec::new();

    let mut engine = Engine::<UscSchema>::new();
    if engine
        .parse_str(xml, |record| match record {
            UscSchemaOutput::MainTitle(main) => {
                if title_main.is_none() {
                    title_main = main.heading;
                }
            }
            UscSchemaOutput::MetaTitle(meta) => {
                if title_meta.is_none() {
                    title_meta = meta.title;
                }
            }
            UscSchemaOutput::SubtitleLevel(level) => levels.push(raw_level(
                "subtitle",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::PartLevel(level) => levels.push(raw_level(
                "part",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::SubpartLevel(level) => levels.push(raw_level(
                "subpart",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::ChapterLevel(level) => levels.push(raw_level(
                "chapter",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::SubchapterLevel(level) => levels.push(raw_level(
                "subchapter",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::DivisionLevel(level) => levels.push(raw_level(
                "division",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::SubdivisionLevel(level) => levels.push(raw_level(
                "subdivision",
                level.identifier,
                level.num,
                level.heading,
            )),
            UscSchemaOutput::SectionBase(section) => {
                let section_num = section
                    .identifier
                    .as_deref()
                    .and_then(parse_section_from_identifier)
                    .or_else(|| section.num_value.as_deref().map(strip_leading_zeros))
                    .or_else(|| section.num.as_deref().and_then(extract_num_from_text))
                    .unwrap_or_default();
                sections.push(RawSection {
                    raw_identifier: section.identifier,
                    section_num,
                    heading: clean_heading(section.num.as_deref(), section.heading),
                    body_raw: section.body_raw,
                    source_credit_raw: section.source_credit_raw,
                    notes_raw: section.notes_raw,
                });
            }
        })
        .is_err()
    {
        return (file_title.to_string(), None, None, Vec::new(), Vec::new());
    }

    (
        file_title.to_string(),
        title_main,
        title_meta,
        levels,
        sections,
    )
}

pub fn parse_usc_xml_stream<F>(xml: &str, file_title: &str, mut on_event: F) -> (String, String)
where
    F: FnMut(USCStreamEvent),
{
    // Stage 1: collect raw records from xmlspec.
    let (title_num, title_main, title_meta, raw_levels, raw_sections) =
        collect_raw(xml, file_title);

    let title_name = title_main
        .filter(|s| !s.trim().is_empty())
        .or_else(|| title_meta.filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| format!("Title {title_num}"));

    on_event(USCStreamEvent::Title(title_name.clone()));

    // Stage 2: resolve hierarchy and emit level records.
    let resolved_levels = resolve_levels(raw_levels, &title_num);
    for level in &resolved_levels {
        on_event(USCStreamEvent::Level(level.level.clone()));
    }

    // Stage 3: scan section body/note formatting details and emit sections.
    let section_scan = parse_section_details(xml);
    let mut section_counts: HashMap<String, usize> = HashMap::new();

    for (idx, raw_section) in raw_sections.into_iter().enumerate() {
        if raw_section.section_num.is_empty() {
            continue;
        }

        let details = section_scan.details.get(idx).cloned().unwrap_or_default();
        let count = section_counts
            .entry(raw_section.section_num.clone())
            .and_modify(|c| *c += 1)
            .or_insert(1);

        let final_section_num = if *count == 1 {
            raw_section.section_num.clone()
        } else {
            format!("{}-{}", raw_section.section_num, count)
        };

        let path = format!("/statutes/usc/section/{title_num}/{final_section_num}");

        let body_text = details.body_parts.join("\n\n");
        let body = normalized_whitespace(&body_text);
        let amendments = details.amendments_parts.join("\n\n");
        let mut note = details.note_parts.join("\n\n");
        if note.is_empty() {
            note = raw_section.notes_raw.clone().unwrap_or_default();
        }
        let mut source_credit = details.source_credit;
        if source_credit.is_empty() {
            source_credit = raw_section.source_credit_raw.clone().unwrap_or_default();
        }
        let body = if body.is_empty() {
            normalized_whitespace(&raw_section.body_raw.unwrap_or_default())
        } else {
            body
        };

        on_event(USCStreamEvent::Section(USCSection {
            section_key: format!("{title_num}:{final_section_num}"),
            title_num: title_num.clone(),
            section_num: final_section_num,
            heading: raw_section.heading,
            body,
            source_credit,
            amendments,
            note,
            path,
            parent_ref: resolve_section_parent(
                section_scan
                    .parent_level_raw_ids
                    .get(idx)
                    .and_then(|s| s.as_deref()),
                raw_section.raw_identifier.as_deref(),
                &resolved_levels,
                &title_num,
            ),
        }));
    }

    (title_num, title_name)
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

fn is_section_body_tag(tag: &str) -> bool {
    matches!(
        tag,
        "chapeau"
            | "p"
            | "subsection"
            | "paragraph"
            | "subparagraph"
            | "clause"
            | "subclause"
            | "item"
            | "subitem"
    )
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
