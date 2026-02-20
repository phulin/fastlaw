use regex::Regex;
use std::cmp::Ordering;
use std::sync::LazyLock;
use tl::VDom;

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[^>]+>").unwrap());
static BOLD_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<\s*(?:b|strong)\b[^>]*>(.*?)</\s*(?:b|strong)\s*>").unwrap()
});
static TITLE_HEADER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^Title\s+([A-Za-z0-9]+(?:\s+Appendix)?)\s*:\s*(.+)$").unwrap()
});
static CHAPTER_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Chapter\s+([A-Za-z0-9.]+)\s*:\s*(.+)$").unwrap());
static CHAPTER_HEADER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^Chapter\s+([A-Za-z0-9.]+)\s*:\s*(.+)$").unwrap());
static SECTION_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^§+\s*([A-Za-z0-9.\-]+)\.\s*(.*)$").unwrap());
static TITLE_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/statutes/title/([^/]+)$").unwrap());
static CHAPTER_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/statutes/chapter/([^/]+)/([^/]+)$").unwrap());
static DISALLOWED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9.\-]+").unwrap());
static HISTORY_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(added|amended|formerly|repealed|renumbered|transferred)\b").unwrap()
});
static INLINE_SECTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(section\s+)([0-9]+[A-Za-z]?)|((?:§|§§)\s*)([0-9]+[A-Za-z]?)").unwrap()
});
static VERSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)actions\s+of\s+the\s+(\d{4})\s+session").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtTitleLink {
    pub title_num: String,
    pub title_name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtTitleIndex {
    pub title_num: String,
    pub title_display_num: String,
    pub title_name: String,
    pub chapters: Vec<VtChapterLink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtChapterLink {
    pub chapter_num: String,
    pub chapter_display_num: String,
    pub chapter_name: String,
    pub url: String,
    pub fullchapter_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtSectionDetail {
    pub section_num: String,
    pub section_name: String,
    pub body: String,
    pub history: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VtFullChapterDetail {
    pub title_display_num: String,
    pub title_name: String,
    pub chapter_display_num: String,
    pub chapter_name: String,
    pub sections: Vec<VtSectionDetail>,
}

pub fn normalize_text(input: &str) -> String {
    WHITESPACE_RE
        .replace_all(input.trim(), " ")
        .trim()
        .to_string()
}

pub fn normalize_text_for_comparison(input: &str) -> String {
    normalize_text(input).replace("**", "")
}

pub fn normalize_designator(value: &str) -> String {
    let lowered = value.trim().to_ascii_lowercase();
    let cleaned = DISALLOWED_RE.replace_all(&lowered, "-");
    cleaned
        .trim_matches('-')
        .replace("--", "-")
        .trim()
        .to_string()
}

pub fn trim_leading_zeroes_for_display(value: &str) -> String {
    let trimmed = value.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn compare_designators(left: &str, right: &str) -> Ordering {
    let left_tokens = sort_tokens(left);
    let right_tokens = sort_tokens(right);
    let count = left_tokens.len().min(right_tokens.len());

    for index in 0..count {
        let left_token = &left_tokens[index];
        let right_token = &right_tokens[index];
        let ordering = match (left_token.parse::<i64>(), right_token.parse::<i64>()) {
            (Ok(a), Ok(b)) => a.cmp(&b),
            _ => left_token.cmp(right_token),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }

    left_tokens.len().cmp(&right_tokens.len())
}

pub fn extract_version_id_from_landing_html(html: &str) -> Option<String> {
    let plain_text = strip_html_tags(html);
    VERSION_RE
        .captures(&plain_text)
        .map(|captures| captures[1].to_string())
}

pub fn parse_title_links(html: &str, base_url: &str) -> Result<Vec<VtTitleLink>, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let mut links: Vec<VtTitleLink> = Vec::new();

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

        let resolved = resolve_and_normalize_url(base_url, href.as_utf8_str().as_ref())?;
        let Some(captures) = TITLE_PATH_RE.captures(resolved.path()) else {
            continue;
        };
        let title_num = captures[1].to_string();
        let text = normalize_text(&tag.inner_text(parser));
        if text.is_empty() {
            continue;
        }
        let title_name = TITLE_HEADER_RE
            .captures(&text)
            .map(|match_| normalize_text(&match_[2]))
            .unwrap_or(text);
        links.push(VtTitleLink {
            title_num,
            title_name,
            url: resolved.to_string(),
        });
    }

    links.sort_by(|a, b| compare_designators(&a.title_num, &b.title_num));
    links.dedup_by(|a, b| a.title_num == b.title_num);
    Ok(links)
}

pub fn parse_title_index(html: &str, base_url: &str) -> Result<VtTitleIndex, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let base = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    let title_num = TITLE_PATH_RE
        .captures(base.path())
        .map(|captures| captures[1].to_string())
        .ok_or_else(|| format!("Unable to parse title code from URL: {base_url}"))?;

    let heading = first_heading_text(&dom, parser).unwrap_or_default();
    let (title_display_num, title_name) = TITLE_HEADER_RE
        .captures(&heading)
        .map(|captures| {
            (
                normalize_text(&captures[1]),
                normalize_text(&captures[2])
                    .trim_end_matches('.')
                    .to_string(),
            )
        })
        .unwrap_or_else(|| (title_num.clone(), heading));

    let mut chapters: Vec<VtChapterLink> = Vec::new();
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

        let resolved = resolve_and_normalize_url(base_url, href.as_utf8_str().as_ref())?;
        let Some(captures) = CHAPTER_PATH_RE.captures(resolved.path()) else {
            continue;
        };
        if captures[1] != title_num {
            continue;
        }

        let chapter_num = captures[2].to_string();
        let link_text = normalize_text(&tag.inner_text(parser));
        let (chapter_display_num, chapter_name) = CHAPTER_LINK_RE
            .captures(&link_text)
            .map(|captures| (normalize_text(&captures[1]), normalize_text(&captures[2])))
            .unwrap_or_else(|| (trim_leading_zeroes(&chapter_num), link_text.clone()));
        let fullchapter_url = chapter_to_fullchapter_url(&resolved)?;
        chapters.push(VtChapterLink {
            chapter_num,
            chapter_display_num,
            chapter_name,
            url: resolved.to_string(),
            fullchapter_url,
        });
    }

    chapters.sort_by(|a, b| compare_designators(&a.chapter_display_num, &b.chapter_display_num));
    chapters.dedup_by(|a, b| a.chapter_num == b.chapter_num);

    Ok(VtTitleIndex {
        title_num,
        title_display_num,
        title_name,
        chapters,
    })
}

pub fn parse_fullchapter_detail(
    html: &str,
    fallback_title_display_num: &str,
    fallback_chapter_display_num: &str,
) -> Result<VtFullChapterDetail, String> {
    let dom = parse_dom(html)?;
    let parser = dom.parser();
    let mut title_display_num = fallback_title_display_num.to_string();
    let mut title_name = String::new();
    let mut chapter_display_num = fallback_chapter_display_num.to_string();
    let mut chapter_name = String::new();
    let mut sections: Vec<VtSectionDetail> = Vec::new();

    let mut current_section_num = String::new();
    let mut current_section_name = String::new();
    let mut current_section_heading = String::new();
    let mut current_body: Vec<String> = Vec::new();
    let mut current_history: Vec<String> = Vec::new();

    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        let tag_name = tag.name().as_utf8_str().to_string();
        let text = extract_text_preserving_bold(tag, parser);
        if text.is_empty() {
            continue;
        }
        let plain_text = text.replace("**", "");

        if tag_name == "h2" {
            if let Some(captures) = TITLE_HEADER_RE.captures(&plain_text) {
                title_display_num = normalize_text(&captures[1]);
                title_name = normalize_text(&captures[2])
                    .trim_end_matches('.')
                    .to_string();
            }
            continue;
        }

        if tag_name == "h3" {
            if let Some(captures) = CHAPTER_HEADER_RE.captures(&plain_text) {
                chapter_display_num = normalize_text(&captures[1]);
                chapter_name = normalize_text(&captures[2])
                    .trim_end_matches('.')
                    .to_string();
            }
            continue;
        }

        if tag_name != "p" && tag_name != "b" {
            continue;
        }

        if let Some(captures) = SECTION_HEADING_RE.captures(&plain_text) {
            let candidate_num = normalize_text(&captures[1]);
            let candidate_name = normalize_text(&captures[2]);
            if tag_name == "b"
                && candidate_num == current_section_num
                && candidate_name == current_section_name
            {
                continue;
            }
            if !current_section_num.is_empty() {
                sections.push(finalize_section(
                    &current_section_num,
                    &current_section_name,
                    &current_body,
                    &current_history,
                ));
            }
            current_section_num = candidate_num;
            current_section_name = candidate_name;
            current_section_heading = plain_text.clone();
            current_body.clear();
            current_history.clear();
            continue;
        }

        if current_section_num.is_empty() {
            continue;
        }

        if plain_text == current_section_heading {
            continue;
        }

        if HISTORY_PREFIX_RE.is_match(&plain_text) {
            current_history.push(plain_text);
        } else {
            current_body.push(text);
        }
    }

    if !current_section_num.is_empty() {
        sections.push(finalize_section(
            &current_section_num,
            &current_section_name,
            &current_body,
            &current_history,
        ));
    }

    Ok(VtFullChapterDetail {
        title_display_num,
        title_name,
        chapter_display_num,
        chapter_name,
        sections,
    })
}

pub fn chapter_to_fullchapter_url(chapter_url: &reqwest::Url) -> Result<String, String> {
    let path = chapter_url.path();
    let Some(captures) = CHAPTER_PATH_RE.captures(path) else {
        return Err(format!("Chapter URL has unexpected path format: {path}"));
    };
    let fullchapter_path = format!("/statutes/fullchapter/{}/{}", &captures[1], &captures[2]);
    let mut out = chapter_url.clone();
    out.set_path(&fullchapter_path);
    out.set_query(None);
    out.set_fragment(None);
    Ok(out.to_string())
}

pub fn resolve_and_normalize_url(base_url: &str, href: &str) -> Result<reqwest::Url, String> {
    if href.starts_with("mailto:") || href.starts_with("javascript:") {
        return Err("Unsupported URL scheme".to_string());
    }

    let base = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    let mut resolved = base
        .join(href)
        .map_err(|e| format!("Failed to resolve URL: {e}"))?;
    resolved.set_fragment(None);
    resolved.set_query(None);
    let _ = resolved.set_scheme("https");

    let host = resolved.host_str().unwrap_or_default();
    if host != "legislature.vermont.gov" {
        return Err(format!("Unexpected host for Vermont statutes URL: {host}"));
    }

    if !resolved.path().starts_with("/statutes/") {
        return Err(format!(
            "Unexpected path for Vermont statutes URL: {}",
            resolved.path()
        ));
    }

    Ok(resolved)
}

pub fn inline_section_cross_references(text: &str, title_num: &str, chapter_num: &str) -> String {
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();

    for captures in INLINE_SECTION_RE.captures_iter(text) {
        if let Some(section_match) = captures.get(2) {
            let section_num = section_match.as_str();
            let link = format!(
                "/statutes/section/{}/{}/{}",
                title_num.to_ascii_lowercase(),
                chapter_num.to_ascii_lowercase(),
                section_num.to_ascii_lowercase()
            );
            replacements.push((
                section_match.start(),
                section_match.end(),
                format!("[{section_num}]({link})"),
            ));
        } else if let Some(section_match) = captures.get(4) {
            let section_num = section_match.as_str();
            let link = format!(
                "/statutes/section/{}/{}/{}",
                title_num.to_ascii_lowercase(),
                chapter_num.to_ascii_lowercase(),
                section_num.to_ascii_lowercase()
            );
            replacements.push((
                section_match.start(),
                section_match.end(),
                format!("[{section_num}]({link})"),
            ));
        }
    }

    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    let mut output = text.to_string();
    for (start, end, replacement) in replacements {
        output.replace_range(start..end, &replacement);
    }
    output
}

fn finalize_section(
    section_num: &str,
    section_name: &str,
    body_parts: &[String],
    history_parts: &[String],
) -> VtSectionDetail {
    let body = body_parts.join("\n\n").trim().to_string();
    let fallback_body = if body.is_empty()
        && (section_name.to_ascii_lowercase().contains("repealed")
            || section_name.to_ascii_lowercase().contains("reserved"))
    {
        section_name.to_string()
    } else {
        body
    };
    let history = if history_parts.is_empty() {
        None
    } else {
        Some(history_parts.join("\n\n").trim().to_string())
    };

    VtSectionDetail {
        section_num: section_num.to_string(),
        section_name: if section_name.is_empty() {
            section_num.to_string()
        } else {
            section_name.to_string()
        },
        body: fallback_body,
        history,
    }
}

fn parse_dom(html: &str) -> Result<VDom<'_>, String> {
    tl::parse(html, tl::ParserOptions::default()).map_err(|e| format!("Failed to parse HTML: {e}"))
}

fn extract_text_preserving_bold(tag: &tl::HTMLTag, parser: &tl::Parser) -> String {
    let mut html = tag.inner_html(parser).as_str().replace("&nbsp;", " ");
    html = html.replace('\u{00A0}', " ");
    html = html
        .replace("<br>", " ")
        .replace("<br/>", " ")
        .replace("<br />", " ");

    let with_bold = BOLD_TAG_RE
        .replace_all(&html, |captures: &regex::Captures| {
            let inner = normalize_text_for_comparison(&TAG_RE.replace_all(&captures[1], " "));
            if inner.is_empty() {
                String::new()
            } else {
                format!(" **{inner}** ")
            }
        })
        .to_string();

    let flattened = TAG_RE.replace_all(&with_bold, " ");
    normalize_text(flattened.as_ref())
}

fn first_heading_text<'a>(dom: &'a VDom<'a>, parser: &'a tl::Parser<'a>) -> Option<String> {
    for node in dom.nodes().iter() {
        let Some(tag) = node.as_tag() else {
            continue;
        };
        let name = tag.name().as_utf8_str().to_string();
        if name == "h1" || name == "h2" {
            let text = normalize_text(&tag.inner_text(parser));
            if TITLE_HEADER_RE.is_match(&text) {
                return Some(text);
            }
        }
    }
    None
}

fn strip_html_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut inside_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => {
                inside_tag = false;
                output.push(' ');
            }
            _ => {
                if !inside_tag {
                    output.push(ch);
                }
            }
        }
    }
    normalize_text(&output)
}

fn sort_tokens(value: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_kind: Option<char> = None;

    for ch in value.trim().chars() {
        let kind = if ch.is_ascii_digit() {
            Some('d')
        } else if ch.is_ascii_alphabetic() {
            Some('a')
        } else {
            None
        };

        match kind {
            Some(kind) => {
                if current_kind != Some(kind) && !current.is_empty() {
                    tokens.push(current.to_ascii_lowercase());
                    current.clear();
                }
                current.push(ch);
                current_kind = Some(kind);
            }
            None => {
                if !current.is_empty() {
                    tokens.push(current.to_ascii_lowercase());
                    current.clear();
                }
                current_kind = None;
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current.to_ascii_lowercase());
    }

    tokens
}

fn trim_leading_zeroes(value: &str) -> String {
    trim_leading_zeroes_for_display(value)
}
