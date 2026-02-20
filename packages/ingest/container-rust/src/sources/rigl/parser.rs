use regex::Regex;
use std::cmp::Ordering;
use std::sync::LazyLock;
use tl::VDom;

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[^>]+>").unwrap());
static TITLE_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)href\s*=\s*["']([^"']*/statutes/title([a-z0-9.]+)[^"']*/index\.htm)["']"#)
        .unwrap()
});
static TITLE_HEADER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Title\s+([A-Za-z0-9.]+)\s*(.*)$").unwrap());
static CHAPTER_HEADER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^Chapters?\s+([A-Za-z0-9.\-]+(?:\s*[—-]\s*[A-Za-z0-9.\-]+)?)\s*(.*)$").unwrap()
});
static SECTION_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^§+\s*([A-Za-z0-9.\-]+(?:\s*[—-]\s*[A-Za-z0-9.\-]+)?)\.?\s*(.*)$").unwrap()
});
static CHAPTER_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^Chapter\s+([A-Za-z0-9.\-]+)\s*(?:[\u{00A0}\s]+)?(.*)$").unwrap()
});
static SECTION_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^§+\s*([A-Za-z0-9.\-]+(?:\s*[—-]\s*[A-Za-z0-9.\-]+)?)\.?\s*(.*)$").unwrap()
});
static TEXT_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9.\-]+").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiglTitleLink {
    pub title_num: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiglTitleIndex {
    pub title_num: String,
    pub title_name: String,
    pub chapters: Vec<RiglChapterLink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiglChapterLink {
    pub chapter_num: String,
    pub chapter_name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiglChapterIndex {
    pub chapter_num: String,
    pub chapter_name: String,
    pub sections: Vec<RiglSectionLink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiglSectionLink {
    pub section_num: String,
    pub section_name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiglSectionDetail {
    pub title_num: String,
    pub title_name: String,
    pub chapter_num: String,
    pub chapter_name: String,
    pub section_num: String,
    pub section_name: String,
    pub body: String,
    pub history: Option<String>,
}

pub fn normalize_text(input: &str) -> String {
    let decoded = input.replace("&nbsp;", " ").replace('\u{00A0}', " ");
    WHITESPACE_RE
        .replace_all(decoded.trim(), " ")
        .trim()
        .to_string()
}

pub fn normalize_designator(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    let cleaned = TEXT_ONLY_RE.replace_all(&lowered, "-");
    cleaned
        .trim_matches('-')
        .replace("--", "-")
        .trim()
        .to_string()
}

fn normalize_dash(value: &str) -> String {
    value.replace('\u{2014}', "-").replace('\u{2013}', "-")
}

fn parse_sort_tokens(value: &str) -> Vec<String> {
    normalize_dash(value)
        .to_ascii_lowercase()
        .split(['-', '.'])
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub fn compare_designators(left: &str, right: &str) -> Ordering {
    let left_tokens = parse_sort_tokens(left);
    let right_tokens = parse_sort_tokens(right);
    let count = left_tokens.len().min(right_tokens.len());

    for i in 0..count {
        let a = &left_tokens[i];
        let b = &right_tokens[i];
        let ordering = match (a.parse::<i64>(), b.parse::<i64>()) {
            (Ok(na), Ok(nb)) => na.cmp(&nb),
            _ => a.cmp(b),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }

    left_tokens.len().cmp(&right_tokens.len())
}

pub fn extract_version_id_from_landing_html(html: &str) -> Option<String> {
    let year_re: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Search\s+the\s+(\d{4})\s+General\s+Laws").unwrap());
    let flattened = TAG_RE.replace_all(html, " ");
    year_re
        .captures(flattened.as_ref())
        .map(|caps| caps[1].to_string())
}

pub fn parse_title_links(html: &str, base_url: &str) -> Result<Vec<RiglTitleLink>, String> {
    let base = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    let mut links: Vec<RiglTitleLink> = Vec::new();
    for captures in TITLE_LINK_RE.captures_iter(html) {
        let href = captures[1].trim();
        let title_num = captures[2].trim().to_string();
        let resolved = base
            .join(href)
            .map_err(|e| format!("Failed to resolve title URL: {e}"))?;
        if resolved.host_str().unwrap_or_default() != "webserver.rilegislature.gov" {
            continue;
        }
        let normalized = normalize_url(&resolved)?;
        let path = normalized.path().to_ascii_lowercase();
        debug_assert!(path.starts_with("/statutes/title") && path.ends_with("/index.htm"));
        if title_num.is_empty() {
            continue;
        }
        links.push(RiglTitleLink {
            title_num,
            url: normalized.to_string(),
        });
    }

    links.sort_by(|a, b| compare_designators(&a.title_num, &b.title_num));
    links.dedup_by(|a, b| a.title_num == b.title_num);
    Ok(links)
}

pub fn parse_title_index(html: &str, base_url: &str) -> Result<RiglTitleIndex, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let base = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;

    let title_header = first_tag_text(&dom, parser, "h1").unwrap_or_default();
    let title_num = infer_title_num_from_url(base_url).unwrap_or_else(|| {
        parse_title_header(&title_header)
            .map(|(num, _)| num)
            .unwrap_or_default()
    });
    let title_name = parse_title_name(&title_header, &title_num);

    let mut chapters: Vec<RiglChapterLink> = Vec::new();
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
        if text.is_empty() {
            continue;
        }
        let Some(caps) = CHAPTER_LINK_RE.captures(&text) else {
            continue;
        };
        let resolved = base
            .join(href.as_utf8_str().as_ref())
            .map_err(|e| format!("Failed to resolve chapter URL: {e}"))?;
        let normalized = normalize_url(&resolved)?;
        chapters.push(RiglChapterLink {
            chapter_num: caps[1].trim().to_string(),
            chapter_name: caps[2].trim().to_string(),
            url: normalized.to_string(),
        });
    }

    chapters.sort_by(|a, b| compare_designators(&a.chapter_num, &b.chapter_num));

    Ok(RiglTitleIndex {
        title_num,
        title_name,
        chapters,
    })
}

pub fn parse_chapter_index(html: &str, base_url: &str) -> Result<RiglChapterIndex, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let base = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    let chapter_header = first_tag_text(&dom, parser, "h2").unwrap_or_default();
    let chapter_num = infer_chapter_num_from_url(base_url).unwrap_or_else(|| {
        parse_chapter_header(&chapter_header)
            .map(|(num, _)| num)
            .unwrap_or_default()
    });
    let chapter_name = parse_chapter_name(&chapter_header, &chapter_num);

    let mut sections: Vec<RiglSectionLink> = Vec::new();
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
        if text.is_empty() {
            continue;
        }
        let Some(caps) = SECTION_LINK_RE.captures(&text) else {
            continue;
        };
        let resolved = base
            .join(href.as_utf8_str().as_ref())
            .map_err(|e| format!("Failed to resolve section URL: {e}"))?;
        let normalized = normalize_url(&resolved)?;
        sections.push(RiglSectionLink {
            section_num: normalize_dash(caps[1].trim())
                .trim_end_matches('.')
                .to_string(),
            section_name: caps[2].trim().to_string(),
            url: normalized.to_string(),
        });
    }

    sections.sort_by(|a, b| compare_designators(&a.section_num, &b.section_num));

    Ok(RiglChapterIndex {
        chapter_num,
        chapter_name,
        sections,
    })
}

pub fn parse_section_detail(html: &str) -> Result<RiglSectionDetail, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let title_header = first_tag_text(&dom, parser, "h1").unwrap_or_default();
    let chapter_header = first_tag_text(&dom, parser, "h2").unwrap_or_default();
    let (title_num, title_name) = parse_title_header(&title_header)?;
    let (chapter_num, chapter_name) = parse_chapter_header(&chapter_header)?;

    let mut section_num = String::new();
    let mut section_name = String::new();
    let mut body_parts: Vec<String> = Vec::new();
    let mut history_parts: Vec<String> = Vec::new();

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != "p" {
            continue;
        }
        let text = normalize_text(&tag.inner_text(parser));
        if text.is_empty() {
            continue;
        }
        if text.starts_with("R.I. Gen. Laws §") {
            continue;
        }

        if let Some(caps) = SECTION_HEADING_RE.captures(&text) {
            if section_num.is_empty() {
                section_num = normalize_dash(caps[1].trim());
                section_num = section_num.trim_end_matches('.').to_string();
                section_name = caps[2].trim().to_string();
                continue;
            }
        }

        if text.starts_with("History of Section.") {
            let history = text
                .trim_start_matches("History of Section.")
                .trim()
                .to_string();
            if !history.is_empty() {
                history_parts.push(history);
            }
            continue;
        }

        body_parts.push(text);
    }

    if section_num.is_empty() {
        return Err("Failed to parse section designator from section page.".to_string());
    }
    if section_name.is_empty() {
        section_name = section_num.clone();
    }

    let body = body_parts.join("\n\n").trim().to_string();
    let history = if history_parts.is_empty() {
        None
    } else {
        Some(history_parts.join("\n\n").trim().to_string())
    };

    Ok(RiglSectionDetail {
        title_num,
        title_name,
        chapter_num,
        chapter_name,
        section_num,
        section_name,
        body,
        history,
    })
}

fn parse_title_header(raw_header: &str) -> Result<(String, String), String> {
    let header = normalize_text(raw_header);
    let Some(caps) = TITLE_HEADER_RE.captures(&header) else {
        return Err(format!("Failed to parse title header: {header}"));
    };
    let title_num = caps[1].trim().to_string();
    let title_name = caps[2].trim().to_string();
    Ok((title_num, title_name))
}

fn parse_title_name(raw_header: &str, title_num: &str) -> String {
    let normalized = normalize_text(raw_header);
    let pattern = format!("title {title_num}").to_ascii_lowercase();
    let lowered = normalized.to_ascii_lowercase();
    if lowered.starts_with(&pattern) {
        return normalized[pattern.len()..].trim().to_string();
    }
    parse_title_header(raw_header)
        .map(|(_, name)| name)
        .unwrap_or_default()
}

fn parse_chapter_header(raw_header: &str) -> Result<(String, String), String> {
    let header = normalize_text(raw_header);
    let Some(caps) = CHAPTER_HEADER_RE.captures(&header) else {
        return Err(format!("Failed to parse chapter header: {header}"));
    };
    let chapter_num = normalize_dash(caps[1].trim())
        .replace(" - ", "-")
        .replace(" — ", "-");
    let chapter_name = caps[2].trim().to_string();
    Ok((chapter_num, chapter_name))
}

fn parse_chapter_name(raw_header: &str, chapter_num: &str) -> String {
    let normalized = normalize_text(raw_header);
    let lowered = normalized.to_ascii_lowercase();
    let exact = format!("chapter {chapter_num}").to_ascii_lowercase();
    let ranged = format!("chapters {chapter_num}").to_ascii_lowercase();
    if lowered.starts_with(&exact) {
        return normalized[exact.len()..].trim().to_string();
    }
    if lowered.starts_with(&ranged) {
        return normalized[ranged.len()..].trim().to_string();
    }
    parse_chapter_header(raw_header)
        .map(|(_, name)| name)
        .unwrap_or_default()
}

fn infer_title_num_from_url(base_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(base_url).ok()?;
    url.path_segments()?
        .find(|segment| segment.to_ascii_lowercase().starts_with("title"))
        .map(|segment| segment[5..].to_string())
}

fn infer_chapter_num_from_url(base_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(base_url).ok()?;
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() < 2 {
        return None;
    }
    segments
        .iter()
        .rev()
        .skip(1)
        .find(|segment| !segment.eq_ignore_ascii_case("Statutes"))
        .map(|segment| (*segment).to_string())
}

fn parse_dom(html: &str) -> Result<VDom<'_>, String> {
    tl::parse(html, tl::ParserOptions::default())
        .map_err(|e| format!("Failed to parse HTML document: {e}"))
}

fn first_tag_text(dom: &VDom, parser: &tl::Parser, tag_name: &str) -> Option<String> {
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        if tag.name().as_utf8_str().as_ref() != tag_name {
            continue;
        }
        let html = tag.inner_html(parser);
        let flattened = TAG_RE.replace_all(html.as_str(), " ");
        let text = normalize_text(flattened.as_ref());
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

pub fn normalize_url(url: &reqwest::Url) -> Result<reqwest::Url, String> {
    let mut normalized = url.clone();
    normalized
        .set_scheme("https")
        .map_err(|_| "Failed to force https URL scheme".to_string())?;
    normalized.set_fragment(None);
    let path = normalized.path().replace("//", "/");
    normalized.set_path(&path);
    if normalized.host_str().unwrap_or_default() != "webserver.rilegislature.gov" {
        return Err(format!(
            "URL host is out of scope for RIGL source: {}",
            normalized
        ));
    }
    if !normalized
        .path()
        .to_ascii_lowercase()
        .starts_with("/statutes/")
    {
        return Err(format!(
            "URL path is out of scope for RIGL source: {}",
            normalized
        ));
    }
    Ok(normalized)
}
