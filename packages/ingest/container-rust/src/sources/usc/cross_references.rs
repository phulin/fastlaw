use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionCrossReference {
    pub section: String,
    #[serde(rename = "titleNum")]
    pub title_num: Option<String>,
    pub offset: usize,
    pub length: usize,
    pub link: Option<String>,
}

#[derive(Debug, Clone)]
enum Token {
    SectionNumber {
        value: String,
        #[allow(dead_code)]
        title_num: Option<String>,
        start: usize,
        end: usize,
    },
    TitleNumber {
        value: String,
        start: usize,
        end: usize,
    },
    Designator {
        #[allow(dead_code)]
        value: String,
    },
    Word {
        value: String,
    },
    Punct {
        value: char,
    },
}

#[derive(Debug, Clone)]
struct SectionMention {
    section: String,
    title_num: Option<String>,
    offset: usize,
    length: usize,
}

#[derive(Debug, Clone)]
enum SectionTarget {
    Section {
        mention: SectionMention,
    },
    Range {
        start: SectionMention,
        end: SectionMention,
    },
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct Qualifier {
    type_: String,
    designators: Vec<String>,
}

static SECTION_NUMBER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d+[a-zA-Z]*(?:-\d+)?$").unwrap());
static TITLE_NUMBER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+$").unwrap());
static DESIGNATOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\(([A-Za-z0-9ivxIVX]+)\)$").unwrap());
static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d+[a-zA-Z]*(?:-\d+)?|\([A-Za-z0-9ivxIVX]+\)|U\.?S\.?C\.?|[A-Za-z]+(?:/[A-Za-z]+)?|[,.;:§]")
        .unwrap()
});

static QUALIFIER_KEYWORDS: LazyLock<std::collections::HashMap<&str, &str>> = LazyLock::new(|| {
    let mut m = std::collections::HashMap::new();
    m.insert("subsection", "subsection");
    m.insert("subsections", "subsection");
    m.insert("subdivision", "subdivision");
    m.insert("subdivisions", "subdivision");
    m.insert("paragraph", "paragraph");
    m.insert("paragraphs", "paragraph");
    m.insert("subparagraph", "subparagraph");
    m.insert("subparagraphs", "subparagraph");
    m.insert("clause", "clause");
    m.insert("clauses", "clause");
    m
});

static SECTION_KEYWORDS: LazyLock<HashSet<&str>> =
    LazyLock::new(|| ["section", "sections", "sec", "secs"].into_iter().collect());
static TITLE_KEYWORDS: LazyLock<HashSet<&str>> = LazyLock::new(|| ["title"].into_iter().collect());
static USC_KEYWORDS: LazyLock<HashSet<&str>> =
    LazyLock::new(|| ["usc", "u.s.c.", "u.s.c"].into_iter().collect());
static SEPARATOR_WORDS: LazyLock<HashSet<&str>> =
    LazyLock::new(|| ["and", "or", "and/or"].into_iter().collect());

/// Extract cross-references from USC section text.
pub fn extract_section_cross_references(
    text: &str,
    current_title_num: &str,
) -> Vec<SectionCrossReference> {
    let tokens = tokenize(text);
    let mut references = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let token = &tokens[index];

        // Check for "42 U.S.C. 1234" style references
        if matches!(token, Token::TitleNumber { .. }) {
            if let Some(parsed) = parse_title_usc_reference(&tokens, index) {
                references.extend(parsed.references);
                index = parsed.next_index;
                continue;
            }
        }

        // Check for "section 1234" or qualifier style references
        if is_qualifier_keyword(token) || is_section_keyword(token) {
            if let Some(parsed) = parse_reference(&tokens, index, current_title_num) {
                references.extend(parsed.references);
                index = parsed.next_index;
                continue;
            }
        }

        index += 1;
    }

    dedupe_references(references)
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();

    for m in TOKEN_RE.find_iter(text) {
        let raw = m.as_str();
        let start = m.start();
        let end = m.end();

        // Section symbol
        if raw == "§" {
            tokens.push(Token::Word {
                value: "section".to_string(),
            });
            continue;
        }

        // U.S.C. pattern
        let lower_stripped = raw.to_lowercase().replace('.', "");
        if USC_KEYWORDS.contains(lower_stripped.as_str()) {
            tokens.push(Token::Word {
                value: "usc".to_string(),
            });
            continue;
        }

        // Pure number (could be title or section number)
        if TITLE_NUMBER_RE.is_match(raw) {
            tokens.push(Token::TitleNumber {
                value: raw.to_string(),
                start,
                end,
            });
            continue;
        }

        // Section number with letter suffix
        if SECTION_NUMBER_RE.is_match(raw) {
            tokens.push(Token::SectionNumber {
                value: raw.to_lowercase(),
                title_num: None,
                start,
                end,
            });
            continue;
        }

        // Designator like (a), (1), (iv)
        if let Some(caps) = DESIGNATOR_RE.captures(raw) {
            tokens.push(Token::Designator {
                value: caps[1].to_string(),
            });
            continue;
        }

        // Punctuation
        if raw.len() == 1 {
            let ch = raw.chars().next().unwrap();
            if matches!(ch, ',' | ';' | '.' | ':') {
                tokens.push(Token::Punct { value: ch });
                continue;
            }
        }

        tokens.push(Token::Word {
            value: raw.to_lowercase(),
        });
    }

    tokens
}

fn is_qualifier_keyword(token: &Token) -> bool {
    matches!(token, Token::Word { value } if QUALIFIER_KEYWORDS.contains_key(value.as_str()))
}

fn is_section_keyword(token: &Token) -> bool {
    matches!(token, Token::Word { value } if SECTION_KEYWORDS.contains(value.as_str()))
}

fn is_title_keyword(token: &Token) -> bool {
    matches!(token, Token::Word { value } if TITLE_KEYWORDS.contains(value.as_str()))
}

fn is_usc_keyword(token: &Token) -> bool {
    matches!(token, Token::Word { value } if value == "usc")
}

fn is_word(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word { value } if value == expected)
}

fn is_designator(token: &Token) -> bool {
    matches!(token, Token::Designator { .. })
}

#[allow(dead_code)]
fn is_section_number(token: &Token) -> bool {
    matches!(token, Token::SectionNumber { .. })
}

fn is_title_number(token: &Token) -> bool {
    matches!(token, Token::TitleNumber { .. })
}

fn is_separator(token: &Token) -> bool {
    match token {
        Token::Punct { value } => *value == ',' || *value == ';',
        Token::Word { value } => SEPARATOR_WORDS.contains(value.as_str()),
        _ => false,
    }
}

struct ParsedReferences {
    references: Vec<SectionCrossReference>,
    next_index: usize,
}

/// Parse "42 U.S.C. 1234" style references
fn parse_title_usc_reference(tokens: &[Token], start_index: usize) -> Option<ParsedReferences> {
    let title_token = tokens.get(start_index)?;
    let title_value = match title_token {
        Token::TitleNumber { value, .. } => value.clone(),
        _ => return None,
    };

    let usc_token = tokens.get(start_index + 1)?;
    if !is_usc_keyword(usc_token) {
        return None;
    }

    let section_list = parse_section_list(tokens, start_index + 2, true, Some(&title_value))?;
    let references = build_references(&section_list.items);
    Some(ParsedReferences {
        references,
        next_index: section_list.next_index,
    })
}

fn parse_reference(
    tokens: &[Token],
    start_index: usize,
    current_title_num: &str,
) -> Option<ParsedReferences> {
    let token = tokens.get(start_index)?;

    if is_qualifier_keyword(token) {
        let qualifier_chains = parse_qualifier_chain_list(tokens, start_index)?;
        let mut index = qualifier_chains.next_index;

        if !tokens.get(index).map_or(false, |t| is_word(t, "of")) {
            return None;
        }
        index += 1;

        let section_keyword = tokens.get(index)?;
        if !is_section_keyword(section_keyword) {
            return None;
        }

        let allow_multiple = match section_keyword {
            Token::Word { value } => value == "sections" || value == "secs",
            _ => false,
        };
        let section_list =
            parse_section_list_with_title(tokens, index + 1, allow_multiple, current_title_num)?;
        let references = build_references(&section_list.items);
        return Some(ParsedReferences {
            references,
            next_index: section_list.next_index,
        });
    }

    if is_section_keyword(token) {
        let section_list =
            parse_section_list_with_title(tokens, start_index + 1, true, current_title_num)?;
        let references = build_references(&section_list.items);
        return Some(ParsedReferences {
            references,
            next_index: section_list.next_index,
        });
    }

    None
}

struct QualifierChainListResult {
    next_index: usize,
}

fn parse_qualifier_chain_list(
    tokens: &[Token],
    start_index: usize,
) -> Option<QualifierChainListResult> {
    let first_chain = parse_qualifier_chain(tokens, start_index)?;
    let mut index = first_chain.next_index;

    loop {
        let sep_index = match consume_separators(tokens, index) {
            Some(i) => i,
            None => break,
        };

        let next_token = match tokens.get(sep_index) {
            Some(t) => t,
            None => break,
        };
        if !is_qualifier_keyword(next_token) {
            break;
        }

        let next_chain = match parse_qualifier_chain(tokens, sep_index) {
            Some(c) => c,
            None => break,
        };

        index = next_chain.next_index;
    }

    Some(QualifierChainListResult { next_index: index })
}

struct QualifierChainResult {
    next_index: usize,
}

fn parse_qualifier_chain(tokens: &[Token], start_index: usize) -> Option<QualifierChainResult> {
    let qualifier = parse_qualifier(tokens, start_index)?;
    let mut index = qualifier.next_index;

    while tokens.get(index).map_or(false, |t| is_word(t, "of")) {
        let next_token = match tokens.get(index + 1) {
            Some(t) => t,
            None => break,
        };
        if !is_qualifier_keyword(next_token) {
            break;
        }
        let next_qualifier = match parse_qualifier(tokens, index + 1) {
            Some(q) => q,
            None => break,
        };
        index = next_qualifier.next_index;
    }

    Some(QualifierChainResult { next_index: index })
}

struct QualifierResult {
    next_index: usize,
}

fn parse_qualifier(tokens: &[Token], start_index: usize) -> Option<QualifierResult> {
    let token = tokens.get(start_index)?;
    if !is_qualifier_keyword(token) {
        return None;
    }

    let list = parse_designator_list(tokens, start_index + 1)?;
    Some(QualifierResult {
        next_index: list.next_index,
    })
}

struct DesignatorListResult {
    next_index: usize,
}

fn parse_designator_list(tokens: &[Token], start_index: usize) -> Option<DesignatorListResult> {
    let first = tokens.get(start_index)?;
    if !is_designator(first) {
        return None;
    }

    let mut index = start_index + 1;

    loop {
        let sep_index = match consume_separators(tokens, index) {
            Some(i) => i,
            None => break,
        };

        let next_token = match tokens.get(sep_index) {
            Some(t) => t,
            None => break,
        };
        if !is_designator(next_token) {
            break;
        }

        index = sep_index + 1;
    }

    Some(DesignatorListResult { next_index: index })
}

struct SectionListResult {
    items: Vec<SectionTarget>,
    next_index: usize,
}

/// Parse section list, looking for optional "of title X" at the end
fn parse_section_list_with_title(
    tokens: &[Token],
    start_index: usize,
    allow_multiple: bool,
    default_title_num: &str,
) -> Option<SectionListResult> {
    let mut section_list =
        parse_section_list(tokens, start_index, allow_multiple, Some(default_title_num))?;

    let mut index = section_list.next_index;

    // Check for "of title X" pattern
    if tokens.get(index).map_or(false, |t| is_word(t, "of"))
        && tokens.get(index + 1).map_or(false, |t| is_title_keyword(t))
    {
        if let Some(title_num_token) = tokens.get(index + 2) {
            if is_title_number(title_num_token) {
                let title_num = match title_num_token {
                    Token::TitleNumber { value, .. } => value.clone(),
                    _ => unreachable!(),
                };
                index += 3;

                // Update all items with the explicit title number
                for item in &mut section_list.items {
                    match item {
                        SectionTarget::Section { mention } => {
                            mention.title_num = Some(title_num.clone());
                        }
                        SectionTarget::Range { start, end, .. } => {
                            start.title_num = Some(title_num.clone());
                            end.title_num = Some(title_num.clone());
                        }
                    }
                }
            }
        }
    }

    Some(SectionListResult {
        items: section_list.items,
        next_index: index,
    })
}

fn parse_section_list(
    tokens: &[Token],
    start_index: usize,
    allow_multiple: bool,
    default_title_num: Option<&str>,
) -> Option<SectionListResult> {
    let first_item = parse_section_item(tokens, start_index, default_title_num)?;
    let mut items = vec![first_item.item];
    let mut index = first_item.next_index;

    if !allow_multiple {
        return Some(SectionListResult {
            items,
            next_index: index,
        });
    }

    loop {
        let sep_index = match consume_separators(tokens, index) {
            Some(i) => i,
            None => break,
        };

        let mut next_index = sep_index;
        if tokens
            .get(next_index)
            .map_or(false, |t| is_section_keyword(t))
        {
            next_index += 1;
        }

        // Check for "42 U.S.C." pattern which should stop the list
        if tokens.get(next_index).map_or(false, |t| is_title_number(t))
            && tokens
                .get(next_index + 1)
                .map_or(false, |t| is_usc_keyword(t))
        {
            break;
        }

        let next_item = match parse_section_item(tokens, next_index, default_title_num) {
            Some(item) => item,
            None => break,
        };

        items.push(next_item.item);
        index = next_item.next_index;
    }

    Some(SectionListResult {
        items,
        next_index: index,
    })
}

struct SectionItemResult {
    item: SectionTarget,
    next_index: usize,
}

fn parse_section_item(
    tokens: &[Token],
    start_index: usize,
    default_title_num: Option<&str>,
) -> Option<SectionItemResult> {
    let token = tokens.get(start_index)?;

    // Normalize titleNumber to sectionNumber
    let (value, start, end) = match token {
        Token::TitleNumber {
            value, start, end, ..
        } => (value.clone(), *start, *end),
        Token::SectionNumber {
            value, start, end, ..
        } => (value.clone(), *start, *end),
        _ => return None,
    };

    let mut index = start_index + 1;
    let start_mention = SectionMention {
        section: value,
        title_num: default_title_num.map(|s| s.to_string()),
        offset: start,
        length: end - start,
    };

    // Check for range: "to" or "through"
    if tokens
        .get(index)
        .map_or(false, |t| is_word(t, "to") || is_word(t, "through"))
    {
        let end_token = tokens.get(index + 1)?;
        let (end_value, end_start, end_end) = match end_token {
            Token::TitleNumber {
                value, start, end, ..
            } => (value.clone(), *start, *end),
            Token::SectionNumber {
                value, start, end, ..
            } => (value.clone(), *start, *end),
            _ => return None,
        };

        index += 2;

        // Check for ", inclusive" or "inclusive"
        if let Some(Token::Punct { value: ',' }) = tokens.get(index) {
            if tokens
                .get(index + 1)
                .map_or(false, |t| is_word(t, "inclusive"))
            {
                index += 2;
            }
        } else if tokens.get(index).map_or(false, |t| is_word(t, "inclusive")) {
            index += 1;
        }

        let end_mention = SectionMention {
            section: end_value,
            title_num: default_title_num.map(|s| s.to_string()),
            offset: end_start,
            length: end_end - end_start,
        };

        return Some(SectionItemResult {
            item: SectionTarget::Range {
                start: start_mention,
                end: end_mention,
            },
            next_index: index,
        });
    }

    Some(SectionItemResult {
        item: SectionTarget::Section {
            mention: start_mention,
        },
        next_index: index,
    })
}

fn consume_separators(tokens: &[Token], start_index: usize) -> Option<usize> {
    let mut index = start_index;
    let mut consumed = false;

    while index < tokens.len() && is_separator(&tokens[index]) {
        consumed = true;
        index += 1;
    }

    if consumed {
        Some(index)
    } else {
        None
    }
}

fn build_references(items: &[SectionTarget]) -> Vec<SectionCrossReference> {
    let mut refs = Vec::new();
    for item in items {
        match item {
            SectionTarget::Section { mention } => {
                refs.push(build_reference(mention));
            }
            SectionTarget::Range { start, end, .. } => {
                refs.push(build_reference(start));
                refs.push(build_reference(end));
            }
        }
    }
    refs
}

fn dedupe_references(references: Vec<SectionCrossReference>) -> Vec<SectionCrossReference> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for r in references {
        let key = format!(
            "{}:{}:{}:{}:{}",
            r.section,
            r.title_num.as_deref().unwrap_or(""),
            r.offset,
            r.length,
            r.link.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            result.push(r);
        }
    }

    result
}

fn build_reference(mention: &SectionMention) -> SectionCrossReference {
    SectionCrossReference {
        section: mention.section.clone(),
        title_num: mention.title_num.clone(),
        offset: mention.offset,
        length: mention.length,
        link: build_section_link(&mention.section, mention.title_num.as_deref()),
    }
}

fn build_section_link(section: &str, title_num: Option<&str>) -> Option<String> {
    title_num.map(|t| format!("/statutes/usc/section/{t}/{section}"))
}
