use regex::Regex;
use std::cmp::Ordering;
use std::sync::LazyLock;
use tl::{Node, Parser, VDom};

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static NON_DESIGNATOR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9-]+").unwrap());
static TITLE_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^TITLE\s+([IVXLCDM]+(?:-[A-Z])?)\s*:\s*(.+)$").unwrap());
static TITLE_HEADER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([IVXLCDM]+(?:-[A-Z])?)\s*:\s*(.+)$").unwrap());
static CHAPTER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^CHAPTER\s+([0-9]+(?:-[A-Z])?)\s*:?\s*(.+)$").unwrap());
static SECTION_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Section:\s*([0-9A-Z-]+:[0-9A-Z-]+)\s*(.+)$").unwrap());
static SECTION_HEADER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Section\s+([0-9A-Z-]+:[0-9A-Z-]+)\s*$").unwrap());
static SECTION_TITLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9A-Z-]+:[0-9A-Z-]+)\s+(.+?)(?:\s*[–-]\s*)?$").unwrap());
static RSA_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bRSA\s+([0-9A-Z-]+:[0-9A-Z-]+)\b").unwrap());
static CURRENT_THROUGH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)current\s+through\s+(\d{4})").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NhTitleLink {
    pub title_num: String,
    pub title_name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NhChapterLink {
    pub chapter_num: String,
    pub chapter_name: String,
    pub url: String,
    pub merged_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NhTitleIndex {
    pub title_num: String,
    pub title_name: String,
    pub chapters: Vec<NhChapterLink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NhSectionLink {
    pub section_num: String,
    pub section_name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NhChapterIndex {
    pub chapter_num: String,
    pub chapter_name: String,
    pub sections: Vec<NhSectionLink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NhSectionDetail {
    pub title_num: String,
    pub title_name: String,
    pub chapter_num: String,
    pub chapter_name: String,
    pub section_num: String,
    pub section_name: String,
    pub body: String,
    pub source_note: Option<String>,
}

pub fn normalize_text(input: &str) -> String {
    let normalized = input
        .replace("&nbsp;", " ")
        .replace('\u{00A0}', " ")
        .replace("&amp;", "&")
        .replace("&#150;", "-")
        .replace("&mdash;", "-")
        .replace("&ndash;", "-");
    WHITESPACE_RE
        .replace_all(normalized.trim(), " ")
        .trim()
        .to_string()
}

pub fn normalize_designator(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    let cleaned = NON_DESIGNATOR_RE.replace_all(&lowered, "-");
    cleaned.trim_matches('-').to_string()
}

pub fn normalize_text_for_comparison(input: &str) -> String {
    normalize_text(input).replace("**", "")
}

pub fn extract_version_id_from_landing_html(html: &str) -> Option<String> {
    CURRENT_THROUGH_RE
        .captures(&normalize_text(html))
        .map(|captures| captures[1].to_string())
}

pub fn parse_title_links(html: &str, base_url: &str) -> Result<Vec<NhTitleLink>, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let mut titles = Vec::new();

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "a" {
            continue;
        }
        let Some(href) = tag.attributes().get("href").flatten() else {
            continue;
        };
        let text = normalize_text(&tag.inner_text(parser));
        let Some(captures) = TITLE_LINK_RE.captures(&text) else {
            continue;
        };
        let url = resolve_and_normalize_url(base_url, href.as_utf8_str().as_ref())?;
        titles.push(NhTitleLink {
            title_num: captures[1].to_string(),
            title_name: captures[2].trim().to_string(),
            url,
        });
    }

    titles.sort_by(|a, b| compare_title_designators(&a.title_num, &b.title_num));
    titles.dedup_by(|a, b| a.title_num == b.title_num);
    Ok(titles)
}

pub fn parse_title_index(html: &str, base_url: &str) -> Result<NhTitleIndex, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let mut title_num = String::new();
    let mut title_name = String::new();

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "h2" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        if let Some(captures) = TITLE_HEADER_RE.captures(&text) {
            title_num = captures[1].to_string();
            title_name = captures[2].trim().to_string();
            break;
        }
    }

    if title_num.is_empty() {
        return Err("Failed to parse New Hampshire title heading from title TOC page.".to_string());
    }

    let mut chapters = Vec::new();
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "a" {
            continue;
        }
        let Some(href) = tag.attributes().get("href").flatten() else {
            continue;
        };
        let text = normalize_text(&tag.inner_text(parser));
        let Some(captures) = CHAPTER_RE.captures(&text) else {
            continue;
        };

        let chapter_num = captures[1].to_string();
        let chapter_name = captures[2].trim().to_string();
        let url = resolve_and_normalize_url(base_url, href.as_utf8_str().as_ref())?;
        chapters.push(NhChapterLink {
            chapter_num,
            chapter_name,
            url,
            merged_url: None,
        });
    }

    chapters.sort_by(|a, b| compare_designators(&a.chapter_num, &b.chapter_num));
    chapters.dedup_by(|a, b| a.chapter_num == b.chapter_num);

    Ok(NhTitleIndex {
        title_num,
        title_name,
        chapters,
    })
}

pub fn parse_chapter_index(html: &str, base_url: &str) -> Result<NhChapterIndex, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let mut chapter_num = String::new();
    let mut chapter_name = String::new();

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "h2" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        let Some(captures) = CHAPTER_RE.captures(&text) else {
            continue;
        };
        chapter_num = captures[1].to_string();
        chapter_name = captures[2].trim().to_string();
        break;
    }

    if chapter_num.is_empty() {
        return Err(
            "Failed to parse New Hampshire chapter heading from chapter TOC page.".to_string(),
        );
    }

    let mut sections = Vec::new();
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "a" {
            continue;
        }
        let Some(href) = tag.attributes().get("href").flatten() else {
            continue;
        };
        let text = normalize_text(&tag.inner_text(parser));
        let Some(captures) = SECTION_LINK_RE.captures(&text) else {
            continue;
        };
        sections.push(NhSectionLink {
            section_num: captures[1].to_string(),
            section_name: captures[2].trim().to_string(),
            url: resolve_and_normalize_url(base_url, href.as_utf8_str().as_ref())?,
        });
    }

    sections.sort_by(|a, b| compare_designators(&a.section_num, &b.section_num));
    sections.dedup_by(|a, b| a.section_num == b.section_num);

    Ok(NhChapterIndex {
        chapter_num,
        chapter_name,
        sections,
    })
}

pub fn parse_section_detail(html: &str) -> Result<NhSectionDetail, String> {
    let mut sections = parse_sections_from_html(html)?;
    if sections.is_empty() {
        return Err("No section content found in New Hampshire section HTML.".to_string());
    }
    Ok(sections.remove(0))
}

pub fn parse_merged_chapter_sections(html: &str) -> Result<Vec<NhSectionDetail>, String> {
    parse_sections_from_html(html)
}

fn parse_sections_from_html(html: &str) -> Result<Vec<NhSectionDetail>, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let (title_num, title_name) = parse_title_header(&dom, parser)?;
    let (chapter_num, chapter_name) = parse_chapter_header(&dom, parser)?;

    let mut sections = Vec::new();
    let mut current_num = String::new();
    let mut current_name = String::new();
    let mut current_body = String::new();
    let mut current_source_note: Option<String> = None;

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        let name = tag.name().as_utf8_str().to_string();
        match name.as_str() {
            "h3" => {
                let text = normalize_text(&tag.inner_text(parser));
                let Some(captures) = SECTION_HEADER_RE.captures(&text) else {
                    continue;
                };

                if !current_num.is_empty() {
                    let body =
                        finalize_body(&current_body, &current_name, current_source_note.as_deref());
                    sections.push(NhSectionDetail {
                        title_num: title_num.clone(),
                        title_name: title_name.clone(),
                        chapter_num: chapter_num.clone(),
                        chapter_name: chapter_name.clone(),
                        section_num: current_num.clone(),
                        section_name: current_name.clone(),
                        body,
                        source_note: current_source_note.clone(),
                    });
                }

                current_num = captures[1].to_string();
                current_name = current_num.clone();
                current_body.clear();
                current_source_note = None;
            }
            "b" => {
                if current_num.is_empty() || !current_name.eq(&current_num) {
                    continue;
                }
                let text = normalize_text(&tag.inner_text(parser));
                if let Some(captures) = SECTION_TITLE_RE.captures(&text) {
                    current_name = captures[2].trim_end_matches('.').trim().to_string();
                }
            }
            "codesect" => {
                if current_num.is_empty() {
                    continue;
                }
                current_body = tag
                    .children()
                    .all(parser)
                    .iter()
                    .map(|child| render_node_as_markdown(child, parser))
                    .collect::<String>();
            }
            "sourcenote" => {
                if current_num.is_empty() {
                    continue;
                }
                let raw = tag
                    .children()
                    .all(parser)
                    .iter()
                    .map(|child| render_node_as_markdown(child, parser))
                    .collect::<String>();
                let note = normalize_text(raw.trim_start_matches("Source.").trim());
                if !note.is_empty() {
                    current_source_note = Some(note);
                }
            }
            _ => {}
        }
    }

    if !current_num.is_empty() {
        let body = finalize_body(&current_body, &current_name, current_source_note.as_deref());
        sections.push(NhSectionDetail {
            title_num,
            title_name,
            chapter_num,
            chapter_name,
            section_num: current_num,
            section_name: current_name,
            body,
            source_note: current_source_note,
        });
    }

    Ok(sections)
}

fn finalize_body(body: &str, section_name: &str, source_note: Option<&str>) -> String {
    let mut normalized = normalize_text(body)
        .replace('\r', "")
        .replace(" .", ".")
        .trim()
        .to_string();
    if let Some(source_note) = source_note {
        let note = normalize_text(source_note);
        if !note.is_empty() && normalized.ends_with(&note) {
            normalized = normalized
                .trim_end_matches(&note)
                .trim_end()
                .trim_end_matches('.')
                .trim()
                .to_string();
            if !normalized.is_empty() {
                normalized.push('.');
            }
        }
    }
    if normalized.is_empty() && section_name.to_ascii_lowercase().contains("repealed") {
        section_name.to_string()
    } else {
        normalized
    }
}

fn parse_title_header(dom: &VDom, parser: &Parser<'_>) -> Result<(String, String), String> {
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "h1" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        let Some(rest) = text.strip_prefix("TITLE ") else {
            continue;
        };
        let split_index = rest
            .char_indices()
            .find_map(|(index, character)| {
                let upper = character.to_ascii_uppercase();
                if matches!(upper, 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M' | '-') {
                    None
                } else {
                    Some(index)
                }
            })
            .unwrap_or(rest.len());
        let title_num = rest[..split_index].trim();
        let title_name = rest[split_index..].trim();
        if title_num.is_empty() || title_name.is_empty() {
            continue;
        }
        return Ok((title_num.to_string(), title_name.to_string()));
    }
    Err("Failed to parse New Hampshire title header.".to_string())
}

fn parse_chapter_header(dom: &VDom, parser: &Parser<'_>) -> Result<(String, String), String> {
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "h2" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        let Some(captures) = CHAPTER_RE.captures(&text) else {
            continue;
        };
        return Ok((captures[1].to_string(), captures[2].trim().to_string()));
    }
    Err("Failed to parse New Hampshire chapter header.".to_string())
}

pub fn resolve_and_normalize_url(base_url: &str, href: &str) -> Result<String, String> {
    if href.starts_with("mailto:") || href.starts_with("javascript:") {
        return Err("Unsupported URL scheme".to_string());
    }

    let base = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    let mut url = base
        .join(href)
        .map_err(|e| format!("Failed to resolve URL: {e}"))?;
    url.set_fragment(None);
    url.set_query(None);
    let _ = url.set_scheme("https");
    let Some(host) = url.host_str() else {
        return Err("URL host missing".to_string());
    };
    if host != "gc.nh.gov" {
        return Err(format!("Unexpected New Hampshire statutes host: {host}"));
    }
    if !url.path().starts_with("/rsa/html/") {
        return Err(format!(
            "Unexpected New Hampshire statutes path: {}",
            url.path()
        ));
    }
    Ok(url.to_string())
}

pub fn inline_nh_cross_references(text: &str, title_num: &str) -> String {
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    for captures in RSA_REF_RE.captures_iter(text) {
        let Some(designator_match) = captures.get(1) else {
            continue;
        };
        let designator = designator_match.as_str();
        let Some((chapter, _section)) = designator.split_once(':') else {
            continue;
        };
        let chapter_slug = normalize_designator(chapter);
        let section_slug = normalize_designator(designator);
        let title_slug = normalize_designator(title_num);
        if chapter_slug.is_empty() || section_slug.is_empty() || title_slug.is_empty() {
            continue;
        }
        replacements.push((
            designator_match.start(),
            designator_match.end(),
            format!(
                "[{designator}](/title/{title_slug}/chapter/{chapter_slug}/section/{section_slug})"
            ),
        ));
    }

    if replacements.is_empty() {
        return text.to_string();
    }

    let mut output = text.to_string();
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    for (start, end, replacement) in replacements {
        if start >= end || end > output.len() {
            continue;
        }
        if !output.is_char_boundary(start) || !output.is_char_boundary(end) {
            continue;
        }
        output.replace_range(start..end, &replacement);
    }
    output
}

pub fn compare_designators(left: &str, right: &str) -> Ordering {
    let left_tokens = designator_tokens(left);
    let right_tokens = designator_tokens(right);
    let count = left_tokens.len().min(right_tokens.len());

    for index in 0..count {
        let a = &left_tokens[index];
        let b = &right_tokens[index];
        let ordering = match (a.parse::<i64>(), b.parse::<i64>()) {
            (Ok(ai), Ok(bi)) => ai.cmp(&bi),
            _ => a.cmp(b),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }

    left_tokens.len().cmp(&right_tokens.len())
}

fn compare_title_designators(left: &str, right: &str) -> Ordering {
    let (left_roman, left_suffix) = split_title_designator(left);
    let (right_roman, right_suffix) = split_title_designator(right);
    match roman_to_int(left_roman).cmp(&roman_to_int(right_roman)) {
        Ordering::Equal => left_suffix.cmp(&right_suffix),
        ordering => ordering,
    }
}

fn split_title_designator(value: &str) -> (&str, &str) {
    let mut parts = value.splitn(2, '-');
    let roman = parts.next().unwrap_or_default();
    let suffix = parts.next().unwrap_or_default();
    (roman, suffix)
}

fn roman_to_int(value: &str) -> i32 {
    let mut total = 0;
    let mut previous = 0;
    for character in value.chars().rev() {
        let current = match character {
            'I' => 1,
            'V' => 5,
            'X' => 10,
            'L' => 50,
            'C' => 100,
            'D' => 500,
            'M' => 1000,
            _ => 0,
        };
        if current < previous {
            total -= current;
        } else {
            total += current;
            previous = current;
        }
    }
    total
}

fn designator_tokens(value: &str) -> Vec<String> {
    value
        .replace(':', "-")
        .split('-')
        .filter(|part| !part.trim().is_empty())
        .map(|part| part.trim().to_ascii_lowercase())
        .collect::<Vec<_>>()
}

fn parse_dom(html: &str) -> Result<VDom<'_>, String> {
    tl::parse(html, tl::ParserOptions::default()).map_err(|e| format!("Failed to parse HTML: {e}"))
}

fn render_node_as_markdown(node: &Node<'_>, parser: &Parser<'_>) -> String {
    match node {
        Node::Raw(raw) => normalize_text(&raw.as_utf8_str()),
        Node::Tag(tag) => {
            let tag_name = tag.name().as_utf8_str().to_ascii_lowercase();
            match tag_name.as_str() {
                "br" => "\n".to_string(),
                "b" | "strong" => {
                    let inner = tag
                        .children()
                        .all(parser)
                        .iter()
                        .map(|child| render_node_as_markdown(child, parser))
                        .collect::<String>();
                    let normalized = normalize_text(&inner);
                    if normalized.is_empty() {
                        String::new()
                    } else {
                        format!("**{normalized}**")
                    }
                }
                _ => tag
                    .children()
                    .all(parser)
                    .iter()
                    .map(|child| render_node_as_markdown(child, parser))
                    .collect::<String>(),
            }
        }
        _ => String::new(),
    }
}
