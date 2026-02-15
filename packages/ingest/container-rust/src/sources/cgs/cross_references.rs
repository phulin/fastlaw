use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionCrossReference {
    pub section: String,
    pub offset: usize,
    pub length: usize,
    pub link: String,
}

#[derive(Debug, Clone)]
enum Token {
    SectionNumber {
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
        #[allow(dead_code)]
        inclusive: bool,
    },
}

static SECTION_NUMBER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d+[a-zA-Z]*-(?:\d+[a-zA-Z]*)(?:-\d+[a-zA-Z]*)*$").unwrap());
static DESIGNATOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\(([A-Za-z0-9ivxIVX]+)\)$").unwrap());
static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\d+[a-zA-Z]*-(?:\d+[a-zA-Z]*)(?:-\d+[a-zA-Z]*)*|\([A-Za-z0-9ivxIVX]+\)|[A-Za-z]+(?:/[A-Za-z]+)?|[,.;:]",
    )
    .unwrap()
});

static QUALIFIER_KEYWORDS: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    [
        "subsection",
        "subsections",
        "subdivision",
        "subdivisions",
        "paragraph",
        "paragraphs",
        "subparagraph",
        "subparagraphs",
        "clause",
        "clauses",
    ]
    .into_iter()
    .collect()
});

static SECTION_KEYWORDS: LazyLock<HashSet<&str>> =
    LazyLock::new(|| ["section", "sections", "sec", "secs"].into_iter().collect());
static SEPARATOR_WORDS: LazyLock<HashSet<&str>> =
    LazyLock::new(|| ["and", "or", "and/or"].into_iter().collect());

pub fn extract_section_cross_references(text: &str) -> Vec<SectionCrossReference> {
    let tokens = tokenize(text);
    let mut references = Vec::new();

    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];

        if is_qualifier_keyword(token) || is_section_keyword(token) {
            if let Some(parsed) = parse_reference(&tokens, index) {
                references.extend(parsed.references);
                index = parsed.next_index;
                continue;
            }
        }

        if is_section_number(token) {
            if let Some(section_list) = parse_section_list(&tokens, index, true) {
                references.extend(build_references(&section_list.items));
                index = section_list.next_index;
                continue;
            }
        }

        index += 1;
    }

    dedupe_references(references)
}

pub fn inline_section_cross_references(text: &str) -> String {
    let mut references = extract_section_cross_references(text);
    references.sort_by(|a, b| b.offset.cmp(&a.offset));

    let mut output = text.to_string();
    for reference in references {
        let start = reference.offset;
        let end = start.saturating_add(reference.length);
        if end > output.len()
            || start >= end
            || !output.is_char_boundary(start)
            || !output.is_char_boundary(end)
        {
            continue;
        }

        let label = &output[start..end];
        let linked = format!("[{label}]({})", reference.link);
        output.replace_range(start..end, &linked);
    }

    output
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();

    for m in TOKEN_RE.find_iter(text) {
        let raw = m.as_str();
        if SECTION_NUMBER_RE.is_match(raw) {
            tokens.push(Token::SectionNumber {
                value: raw.to_lowercase(),
                start: m.start(),
                end: m.end(),
            });
            continue;
        }

        if let Some(caps) = DESIGNATOR_RE.captures(raw) {
            tokens.push(Token::Designator {
                value: caps[1].to_string(),
            });
            continue;
        }

        if raw.len() == 1 {
            let value = raw
                .chars()
                .next()
                .expect("punctuation should have one char");
            if matches!(value, ',' | ';' | '.' | ':') {
                tokens.push(Token::Punct { value });
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
    matches!(token, Token::Word { value } if QUALIFIER_KEYWORDS.contains(value.as_str()))
}

fn is_section_keyword(token: &Token) -> bool {
    matches!(token, Token::Word { value } if SECTION_KEYWORDS.contains(value.as_str()))
}

fn is_word(token: Option<&Token>, expected: &str) -> bool {
    matches!(token, Some(Token::Word { value }) if value == expected)
}

fn is_designator(token: Option<&Token>) -> bool {
    matches!(token, Some(Token::Designator { .. }))
}

fn is_section_number(token: &Token) -> bool {
    matches!(token, Token::SectionNumber { .. })
}

fn is_separator(token: Option<&Token>) -> bool {
    match token {
        Some(Token::Punct { value }) => *value == ',' || *value == ';',
        Some(Token::Word { value }) => SEPARATOR_WORDS.contains(value.as_str()),
        _ => false,
    }
}

struct ParsedReferences {
    references: Vec<SectionCrossReference>,
    next_index: usize,
}

fn parse_reference(tokens: &[Token], start_index: usize) -> Option<ParsedReferences> {
    let token = tokens.get(start_index)?;

    if is_qualifier_keyword(token) {
        let qualifier_chains = parse_qualifier_chain_list(tokens, start_index)?;
        let mut index = qualifier_chains.next_index;
        if !is_word(tokens.get(index), "of") {
            return None;
        }
        index += 1;

        let section_keyword = tokens.get(index)?;
        if !is_section_keyword(section_keyword) {
            return None;
        }

        let allow_multiple = matches!(section_keyword, Token::Word { value } if value == "sections" || value == "secs");
        let section_list = parse_section_list(tokens, index + 1, allow_multiple)?;
        let references = build_references(&section_list.items);
        return Some(ParsedReferences {
            references,
            next_index: section_list.next_index,
        });
    }

    if is_section_keyword(token) {
        let section_list = parse_section_list(tokens, start_index + 1, true)?;
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
            Some(value) => value,
            None => break,
        };

        let next_token = tokens.get(sep_index)?;
        if !is_qualifier_keyword(next_token) {
            break;
        }

        let next_chain = parse_qualifier_chain(tokens, sep_index)?;
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

    while is_word(tokens.get(index), "of") {
        let next_token = tokens.get(index + 1)?;
        if !is_qualifier_keyword(next_token) {
            break;
        }

        let next_qualifier = parse_qualifier(tokens, index + 1)?;
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
    let first = tokens.get(start_index);
    if !is_designator(first) {
        return None;
    }

    let mut index = start_index + 1;
    loop {
        let sep_index = match consume_separators(tokens, index) {
            Some(value) => value,
            None => break,
        };

        if !is_designator(tokens.get(sep_index)) {
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

fn parse_section_list(
    tokens: &[Token],
    start_index: usize,
    allow_multiple: bool,
) -> Option<SectionListResult> {
    let first_item = parse_section_item(tokens, start_index)?;
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
            Some(value) => value,
            None => break,
        };

        let mut next_index = sep_index;
        if matches!(tokens.get(next_index), Some(token) if is_section_keyword(token)) {
            next_index += 1;
        }

        let next_item = match parse_section_item(tokens, next_index) {
            Some(value) => value,
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

fn parse_section_item(tokens: &[Token], start_index: usize) -> Option<SectionItemResult> {
    let token = tokens.get(start_index)?;
    let (value, start, end) = match token {
        Token::SectionNumber { value, start, end } => (value.clone(), *start, *end),
        _ => return None,
    };

    let mut index = start_index + 1;
    let start_mention = SectionMention {
        section: value,
        offset: start,
        length: end - start,
    };

    if is_word(tokens.get(index), "to") {
        let end_token = tokens.get(index + 1)?;
        let (end_value, end_start, end_end) = match end_token {
            Token::SectionNumber { value, start, end } => (value.clone(), *start, *end),
            _ => return None,
        };

        index += 2;

        let mut inclusive = false;
        if matches!(tokens.get(index), Some(Token::Punct { value: ',' })) {
            if is_word(tokens.get(index + 1), "inclusive") {
                inclusive = true;
                index += 2;
            }
        } else if is_word(tokens.get(index), "inclusive") {
            inclusive = true;
            index += 1;
        }

        let end_mention = SectionMention {
            section: end_value,
            offset: end_start,
            length: end_end - end_start,
        };

        return Some(SectionItemResult {
            item: SectionTarget::Range {
                start: start_mention,
                end: end_mention,
                inclusive,
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

    while is_separator(tokens.get(index)) {
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
    let mut references = Vec::new();

    for item in items {
        match item {
            SectionTarget::Section { mention } => references.push(build_reference(mention)),
            SectionTarget::Range { start, end, .. } => {
                references.push(build_reference(start));
                references.push(build_reference(end));
            }
        }
    }

    references
}

fn dedupe_references(references: Vec<SectionCrossReference>) -> Vec<SectionCrossReference> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();

    for reference in references {
        let key = format!(
            "{}:{}:{}:{}",
            reference.section, reference.offset, reference.length, reference.link
        );
        if seen.insert(key) {
            deduped.push(reference);
        }
    }

    deduped
}

fn build_reference(mention: &SectionMention) -> SectionCrossReference {
    SectionCrossReference {
        section: mention.section.clone(),
        offset: mention.offset,
        length: mention.length,
        link: format!("/statutes/section/{}", mention.section),
    }
}
