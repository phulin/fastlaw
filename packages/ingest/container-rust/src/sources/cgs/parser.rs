use regex::Regex;
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;
use tl::NodeHandle;

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static CHAPTER_TITLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(Article|Chapter)\s+[^-]+-\s+").unwrap());
static DESIGNATOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^0*([0-9]+)([a-zA-Z]*)$").unwrap());
static LABEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(Secs?)\.\s+([^.]+)\.\s*(.*)$").unwrap());
static TRAILING_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:PART|SUBPART|ARTICLE|CHAPTER)\s+[IVXLC\d]+$|^\(([A-Z]|[IVXLC]+)\)$").unwrap()
});
static UPPERCASE_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z\s\-,&]+$").unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CgsUnitKind {
    Chapter,
    Article,
}

impl CgsUnitKind {
    pub fn from_url(url: &str) -> Self {
        if url.to_ascii_lowercase().contains("/art_") {
            Self::Article
        } else {
            Self::Chapter
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chapter => "chapter",
            Self::Article => "article",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CgsParsedSection {
    pub string_id: String,
    pub level_name: String,
    pub level_index: i32,
    pub name: Option<String>,
    pub path: String,
    pub readable_id: String,
    pub body: String,
    pub history_short: Option<String>,
    pub history_long: Option<String>,
    pub citations: Option<String>,
    pub see_also: Option<String>,
    pub parent_string_id: String,
    pub sort_order: i32,
    pub source_url: String,
}

#[derive(Debug, Clone)]
pub struct CgsChapterParseResult {
    pub chapter_title: Option<String>,
    pub chapter_number: Option<String>,
    pub sections: Vec<CgsParsedSection>,
}

#[derive(Debug, Clone)]
struct SectionData {
    section_id: String,
    name: String,
    parts: TextParts,
}

#[derive(Debug, Clone)]
struct TextParts {
    body: Vec<String>,
    history_short: Vec<String>,
    history_long: Vec<String>,
    citations: Vec<String>,
    see_also: Vec<String>,
}

impl TextParts {
    fn target_mut(&mut self, target: ContentTarget) -> &mut Vec<String> {
        match target {
            ContentTarget::Body => &mut self.body,
            ContentTarget::HistoryShort => &mut self.history_short,
            ContentTarget::HistoryLong => &mut self.history_long,
            ContentTarget::Citations => &mut self.citations,
            ContentTarget::SeeAlso => &mut self.see_also,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentTarget {
    Body,
    HistoryShort,
    HistoryLong,
    Citations,
    SeeAlso,
}

#[derive(Debug, Clone)]
struct ParseState {
    sections: Vec<SectionData>,
    current_section_index: Option<usize>,
    in_script: bool,
    in_style: bool,
    in_script_or_style: bool,
    current_target: ContentTarget,
    toc_map: BTreeMap<String, String>,
}

impl ParseState {
    fn new(toc_map: BTreeMap<String, String>) -> Self {
        Self {
            sections: Vec::new(),
            current_section_index: None,
            in_script: false,
            in_style: false,
            in_script_or_style: false,
            current_target: ContentTarget::Body,
            toc_map,
        }
    }

    fn current_parts_mut(&mut self) -> Option<&mut TextParts> {
        self.current_section_index
            .and_then(move |index| self.sections.get_mut(index))
            .map(|section| &mut section.parts)
    }

    fn add_newline(&mut self, target: ContentTarget) {
        let Some(parts) = self.current_parts_mut() else {
            return;
        };

        let target_parts = parts.target_mut(target);
        if target_parts.is_empty() {
            target_parts.push("\n".to_string());
            return;
        }

        let Some(last) = target_parts.last() else {
            return;
        };
        if !last.ends_with('\n') {
            target_parts.push("\n".to_string());
        }
    }

    fn start_section(&mut self, section_id: &str) {
        self.current_section_index = Some(self.sections.len());
        self.current_target = ContentTarget::Body; // Reset to body for new section

        let name = self.toc_map.get(section_id).cloned().unwrap_or_default();
        self.sections.push(SectionData {
            section_id: section_id.to_string(),
            name,
            parts: TextParts {
                body: Vec::new(),
                history_short: Vec::new(),
                history_long: Vec::new(),
                citations: Vec::new(),
                see_also: Vec::new(),
            },
        });
    }

    fn push_text(&mut self, text: &str) {
        let target = self.current_target;
        let Some(parts) = self.current_parts_mut() else {
            return;
        };
        parts.target_mut(target).push(text.to_string());
    }
}

pub fn parse_cgs_chapter_html(
    html: &str,
    chapter_id: &str,
    source_url: &str,
    unit_kind: CgsUnitKind,
) -> CgsChapterParseResult {
    let dom = tl::parse(html, tl::ParserOptions::default()).unwrap();
    let toc_map = extract_toc_map(&dom);
    let chapter_title = extract_chapter_title(&dom);
    let chapter_number = extract_chapter_number(&dom);

    // Build skip map for catchln and nav_tbl descendants
    let skip_map = build_skip_map(&dom);

    let mut state = ParseState::new(toc_map);
    let parser = dom.parser();

    // Process all nodes in flat order, skipping descendants of catchln/nav_tbl
    for index in 0..dom.nodes().len() {
        if skip_map[index] {
            continue;
        }

        let node_handle = NodeHandle::new(index as u32);
        let Some(node) = node_handle.get(parser) else {
            continue;
        };

        // Handle text nodes
        if let Some(text) = node.as_raw() {
            if state.in_script || state.in_style {
                continue;
            }
            state.push_text(text.as_utf8_str().as_ref());
            continue;
        }

        // Handle tag nodes
        if let Some(tag_data) = node.as_tag() {
            let tag = tag_data.name().as_utf8_str();
            let classes = class_set(tag_data);

            // Start new section on catchln
            if tag == "span" && classes.contains("catchln") {
                if let Some(section_id) = tag_data.attributes().id() {
                    state.start_section(section_id.as_utf8_str().as_ref());
                }
                continue;
            }

            // Track script/style
            if tag == "script" || tag == "style" {
                state.in_script_or_style = !state.in_script_or_style;
                continue;
            }

            if state.in_script || state.in_style {
                continue;
            }

            // Switch content target
            if let Some(target) = classify_target(&classes) {
                state.current_target = target;
            }

            // Add newlines for block elements
            if matches!(tag.as_ref(), "br" | "hr") {
                state.add_newline(state.current_target);
            } else if is_block_tag(tag.as_ref()) {
                // Add double newline for block tags to create paragraph separation
                let target = state.current_target;
                state.add_newline(target);
                // Force add second newline for blank line between paragraphs
                if let Some(parts) = state.current_parts_mut() {
                    parts.target_mut(target).push("\n".to_string());
                }
            }

            // Handle table cells
            if (tag == "td" || tag == "th") && state.current_section_index.is_some() {
                let target = state.current_target;
                if let Some(parts) = state.current_parts_mut() {
                    let target_parts = parts.target_mut(target);
                    if !target_parts.is_empty() {
                        target_parts.push(" | ".to_string());
                    }
                }
            }
        }
    }

    CgsChapterParseResult {
        chapter_title,
        chapter_number,
        sections: build_sections_from_parsed_data(
            state.sections,
            chapter_id,
            source_url,
            unit_kind,
        ),
    }
}

fn build_skip_map(dom: &tl::VDom) -> Vec<bool> {
    let mut skip_map = vec![false; dom.nodes().len()];

    // Mark nodes that should be skipped based on parent element
    // We need to find which nodes are TRUE children (not siblings) of catchln/nav_tbl
    // Strategy: For catchln, only skip direct text children (the heading text)
    // For nav_tbl, skip all content (we'll use a different approach)

    for (index, node) in dom.nodes().iter().enumerate() {
        if let Some(tag) = node.as_tag() {
            let classes = class_set(tag);

            // For catchln spans: mark only direct text children
            if tag.name() == "span" && classes.contains("catchln") {
                // Mark only immediate children (text nodes inside the span)
                for child in tag.children().top().iter().take(10) {
                    // Limit to first 10 to avoid siblings
                    let child_index = child.get_inner() as usize;
                    // Only mark if it's immediately after this tag (likely a true child)
                    if child_index > index && child_index < index + 10 {
                        skip_map[child_index] = true;
                    }
                }
            }

            // For nav_tbl: mark the table and everything "inside" it by range
            // Since tl's children() returns siblings too, use a heuristic:
            // mark all nodes from table index to the next non-descendant
            if tag.name() == "table" && classes.contains("nav_tbl") {
                // Find the extent of this table by looking for the next major element
                // Mark from index+1 until we find a <p> tag (start of next section content)
                for i in (index + 1)..dom.nodes().len() {
                    skip_map[i] = true;

                    // Stop when we hit the next paragraph or catchln span
                    if let Some(next_node) = dom.nodes().get(i) {
                        if let Some(next_tag) = next_node.as_tag() {
                            let next_classes = class_set(next_tag);
                            if next_tag.name() == "p" && !next_classes.contains("nav_tbl") {
                                // Found next content paragraph, stop here but don't skip it
                                skip_map[i] = false;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    skip_map
}

fn class_set(tag: &tl::HTMLTag) -> HashSet<String> {
    tag.attributes()
        .class()
        .map(|c| c.as_utf8_str())
        .unwrap_or_default()
        .split_whitespace()
        .map(ToString::to_string)
        .collect()
}

fn classify_target(classes: &HashSet<String>) -> Option<ContentTarget> {
    if classes.contains("source") || classes.contains("source-first") {
        return Some(ContentTarget::HistoryShort);
    }
    if classes.contains("history") || classes.contains("history-first") {
        return Some(ContentTarget::HistoryLong);
    }
    if classes.contains("annotation") || classes.contains("annotation-first") {
        return Some(ContentTarget::Citations);
    }
    if classes.contains("cross-ref") || classes.contains("cross-ref-first") {
        return Some(ContentTarget::SeeAlso);
    }

    None
}

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div" | "table" | "tr" | "ul" | "ol" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
    )
}

fn extract_toc_map(dom: &tl::VDom) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let parser = dom.parser();

    for node in dom.nodes() {
        let Some(tag) = node.as_tag() else {
            continue;
        };

        if tag.name() == "p" {
            let classes = class_set(tag);
            if classes.contains("toc_catchln") {
                // Look for anchor tags in children
                for child_handle in tag.children().top().iter() {
                    if let Some(child_node) = child_handle.get(parser) {
                        if let Some(child_tag) = child_node.as_tag() {
                            if child_tag.name() == "a" {
                                if let Some(href_bytes) =
                                    child_tag.attributes().get("href").flatten()
                                {
                                    let href_val = href_bytes.as_utf8_str();
                                    if let Some(section_id) = href_val.as_ref().strip_prefix('#') {
                                        let text = extract_text_content(dom, *child_handle);
                                        let collapsed = collapse_text(text);
                                        if !collapsed.is_empty() {
                                            map.insert(section_id.to_string(), collapsed);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    map
}

fn extract_text_content(dom: &tl::VDom, node_handle: NodeHandle) -> String {
    let mut text = String::new();

    fn collect_text(dom: &tl::VDom, node_handle: NodeHandle, output: &mut String) {
        let parser = dom.parser();
        let Some(node) = node_handle.get(parser) else {
            return;
        };

        if let Some(raw_text) = node.as_raw() {
            output.push_str(raw_text.as_utf8_str().as_ref());
            return;
        }

        if let Some(tag) = node.as_tag() {
            for child in tag.children().top().iter() {
                collect_text(dom, *child, output);
            }
        }
    }

    collect_text(dom, node_handle, &mut text);
    text
}

fn extract_chapter_title(dom: &tl::VDom) -> Option<String> {
    for (index, node) in dom.nodes().iter().enumerate() {
        let Some(tag) = node.as_tag() else {
            continue;
        };

        if tag.name() == "title" {
            let node_handle = NodeHandle::new(index as u32);
            let text = extract_text_content(dom, node_handle);
            let title = collapse_text(text);

            if title.is_empty() {
                return None;
            }

            return Some(CHAPTER_TITLE_RE.replace(&title, "").trim().to_string());
        }
    }

    None
}

fn extract_chapter_number(dom: &tl::VDom) -> Option<String> {
    for node in dom.nodes() {
        let Some(tag) = node.as_tag() else {
            continue;
        };

        if tag.name() == "meta" {
            if let Some(name_bytes) = tag.attributes().get("name").flatten() {
                let name_val = name_bytes.as_utf8_str();
                if name_val.as_ref() == "Number" {
                    if let Some(content_bytes) = tag.attributes().get("content").flatten() {
                        let content_val = content_bytes.as_utf8_str();
                        let number = content_val.as_ref().trim();
                        if number.is_empty() {
                            continue;
                        }

                        if let Some(caps) =
                            Regex::new(r"(?i)(?:ARTICLE|CHAPTER)\s+([0-9]+[a-zA-Z]*)")
                                .expect("valid chapter number regex")
                                .captures(number)
                        {
                            return Some(caps[1].to_string());
                        }

                        return Some(number.to_string());
                    }
                }
            }
        }
    }

    None
}

fn build_sections_from_parsed_data(
    sections: Vec<SectionData>,
    chapter_id: &str,
    source_url: &str,
    unit_kind: CgsUnitKind,
) -> Vec<CgsParsedSection> {
    let mut results = Vec::new();

    for (index, section) in sections.into_iter().enumerate() {
        let label = if section.name.is_empty() {
            section.section_id.clone()
        } else {
            section.name.clone()
        };

        let parsed_label = parse_label(&label);

        let section_name = parsed_label.title.clone().or_else(|| {
            if label.is_empty() {
                None
            } else {
                Some(
                    label
                        .trim_start_matches("Sec. ")
                        .trim_start_matches("Secs. ")
                        .trim_end_matches('.')
                        .trim()
                        .to_string(),
                )
            }
        });

        let body = trim_trailing_headings(&format_text(&section.parts.body));
        let history_short = nullable_text(format_text(&section.parts.history_short));
        let history_long = nullable_text(format_text(&section.parts.history_long));
        let citations = nullable_text(format_text(&section.parts.citations));
        let see_also = nullable_text(format_text(&section.parts.see_also));

        let normalized_number = parsed_label
            .number
            .or_else(|| {
                Some(
                    section
                        .section_id
                        .trim_start_matches("sec_")
                        .trim_start_matches("secs_")
                        .to_string(),
                )
            })
            .unwrap_or_else(|| section.section_id.clone())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("_");

        let readable_id = normalized_number.replace('_', " ");
        results.push(CgsParsedSection {
            string_id: format!("cgs/section/{normalized_number}"),
            level_name: "section".to_string(),
            level_index: 2,
            name: section_name,
            path: format!("/statutes/cgs/section/{normalized_number}"),
            readable_id,
            body,
            history_short,
            history_long,
            citations,
            see_also,
            parent_string_id: format!("cgs/{}/{chapter_id}", unit_kind.as_str()),
            sort_order: index as i32,
            source_url: source_url.to_string(),
        });
    }

    results
}

fn nullable_text(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

pub fn format_text(parts: &[String]) -> String {
    let raw = parts.join("");
    let lines = raw.split('\n').map(collapse_text).collect::<Vec<_>>();

    let mut normalized = Vec::new();
    let mut previous_blank = false;
    for line in lines {
        if line.is_empty() {
            if !previous_blank {
                normalized.push(String::new());
            }
            previous_blank = true;
        } else {
            normalized.push(line);
            previous_blank = false;
        }
    }

    normalized.join("\n").trim().to_string()
}

fn trim_trailing_headings(body_text: &str) -> String {
    if body_text.is_empty() {
        return String::new();
    }

    let mut lines = body_text
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }

    while let Some(last) = lines.last() {
        let line = last.trim();
        let is_heading = TRAILING_HEADING_RE.is_match(line)
            || (UPPERCASE_HEADING_RE.is_match(line) && line.len() <= 80);
        if !is_heading {
            break;
        }

        lines.pop();
        while lines.last().is_some_and(|line| line.trim().is_empty()) {
            lines.pop();
        }
    }

    lines.join("\n").trim().to_string()
}

fn collapse_text(value: impl AsRef<str>) -> String {
    WHITESPACE_RE
        .replace_all(value.as_ref().trim(), " ")
        .trim()
        .to_string()
}

pub fn format_designator_padded(value: Option<&str>, width: usize) -> Option<String> {
    let value = value?;
    let captures = DESIGNATOR_RE.captures(value)?;
    let number = captures[1].parse::<u32>().ok()?.to_string();
    let suffix = captures[2].to_ascii_lowercase();
    Some(format!("{}{suffix}", format!("{number:0>width$}")))
}

pub fn format_designator_display(value: Option<&str>) -> Option<String> {
    let value = value?;
    let captures = DESIGNATOR_RE.captures(value)?;
    let number = captures[1].parse::<u32>().ok()?.to_string();
    let suffix = captures[2].to_ascii_lowercase();
    Some(format!("{number}{suffix}"))
}

pub fn normalize_designator(value: Option<&str>) -> Option<String> {
    let value = value?;
    let captures = DESIGNATOR_RE.captures(value)?;
    let number = captures[1].parse::<u32>().ok()?.to_string();
    let suffix = &captures[2];
    Some(format!("{number}{suffix}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLabel {
    pub number: Option<String>,
    pub title: Option<String>,
    pub range_start: Option<String>,
    pub range_end: Option<String>,
}

pub fn parse_label(label: &str) -> ParsedLabel {
    let captures = match LABEL_RE.captures(label) {
        Some(value) => value,
        None => {
            return ParsedLabel {
                number: None,
                title: None,
                range_start: None,
                range_end: None,
            }
        }
    };

    let is_multiple = captures[1].eq_ignore_ascii_case("secs");
    let number = captures[2].trim().to_string();
    let title = {
        let value = captures[3].trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    };

    if is_multiple {
        if let Some((start, end)) = number.split_once(" to ") {
            return ParsedLabel {
                number: Some(number.clone()),
                title,
                range_start: Some(start.trim().to_string()),
                range_end: Some(end.trim().to_string()),
            };
        }

        return ParsedLabel {
            number: Some(number),
            title,
            range_start: None,
            range_end: None,
        };
    }

    ParsedLabel {
        number: Some(number.clone()),
        title,
        range_start: Some(number.clone()),
        range_end: Some(number),
    }
}

pub fn designator_sort_order(value: &str) -> i32 {
    let captures = match DESIGNATOR_RE.captures(value) {
        Some(value) => value,
        None => return i32::MAX,
    };

    let numeric = match captures[1].parse::<i32>() {
        Ok(value) => value,
        Err(_) => return i32::MAX,
    };

    let suffix = captures[2].to_ascii_lowercase();
    let mut suffix_value: i32 = 0;
    for ch in suffix.chars() {
        if !ch.is_ascii_lowercase() {
            return i32::MAX;
        }
        suffix_value = suffix_value
            .saturating_mul(27)
            .saturating_add((ch as i32) - ('a' as i32) + 1);
    }

    numeric.saturating_mul(100000).saturating_add(suffix_value)
}

pub fn extract_chapter_title_from_html(html: &str) -> Option<String> {
    let dom = tl::parse(html, tl::ParserOptions::default()).unwrap();
    extract_chapter_title(&dom)
}

pub fn extract_section_ids_from_toc(html: &str) -> Vec<String> {
    let dom = tl::parse(html, tl::ParserOptions::default()).unwrap();
    extract_toc_map(&dom).keys().cloned().collect()
}
