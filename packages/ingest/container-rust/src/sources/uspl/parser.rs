use quick_xml::events::Event;
use quick_xml::Reader;

/// A contiguous run of text or a hyperlink within law content.
#[derive(Debug, Clone)]
pub enum Inline {
    Text(String),
    Link { text: String, href: String },
}

/// A block of structured content within a law.
#[derive(Debug, Clone)]
pub enum Block {
    /// Plain paragraph (content, enacting formula, chapeau, continuation…)
    Para(Vec<Inline>),
    /// Section or title heading, rendered prominently
    Heading { level: u8, inlines: Vec<Inline> },
    /// Outline item: "(a)", "(1)", "(A)" followed by content
    Outline {
        marker: String,
        inlines: Vec<Inline>,
    },
    /// Approval date / action
    Action(Vec<Inline>),
    /// Quoted text (indented block)
    Quoted(Vec<Block>),
}

#[derive(Debug, Clone)]
pub struct ParsedLaw {
    pub public_law_number: String, // "106-1"
    pub stat_citation: String,     // "113 Stat. 3"
    pub official_title: String,
    pub approved_date: String,
    pub congress: u32,
    pub blocks: Vec<Block>,
    pub source_page: String, // "/us/stat/N/P" first page identifier
}

/// Parse USLM XML for a single Statutes at Large volume.
/// Calls `on_law` for each public law found.
pub fn parse_uslm_volume<F>(xml: &str, mut on_law: F)
where
    F: FnMut(ParsedLaw),
{
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();

    // State machine
    let mut in_plaw = false;
    let mut skip_depth: Option<usize> = None; // skip subtrees (legislativeHistory, preface)
    let mut depth: usize = 0;

    // Per-law metadata
    let mut public_private = String::new();
    let mut doc_number = String::new();
    let mut stat_citation = String::new();
    let mut approved_date = String::new();
    let mut congress_str = String::new();
    let mut official_title = String::new();
    let mut source_page = String::new();

    // Content state
    let mut block_stack: Vec<BlockBuilder> = Vec::new(); // nested block builders
    let mut law_blocks: Vec<Block> = Vec::new();

    // Meta collection
    let mut in_meta = false;
    let mut in_main = false;
    let mut meta_field = MetaField::None;
    let mut meta_buf = String::new();

    // Ref state
    let mut ref_href = String::new();
    let mut in_ref = false;
    let mut ref_text_buf = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let tag = name.as_ref();
                depth += 1;

                // Check for skip zone
                if let Some(d) = skip_depth {
                    if depth > d {
                        buf.clear();
                        continue;
                    }
                }

                match tag {
                    b"pLaw" => {
                        in_plaw = true;
                        public_private.clear();
                        doc_number.clear();
                        stat_citation.clear();
                        approved_date.clear();
                        congress_str.clear();
                        official_title.clear();
                        source_page.clear();
                        law_blocks.clear();
                        block_stack.clear();
                        in_meta = false;
                        in_main = false;
                    }
                    b"meta" if in_plaw && !in_main => {
                        in_meta = true;
                    }
                    b"main" if in_plaw => {
                        in_meta = false;
                        in_main = true;
                    }
                    // Skip subtrees we don't need
                    b"legislativeHistory" | b"preface" if in_plaw => {
                        skip_depth = Some(depth);
                    }
                    _ if in_plaw && in_meta => {
                        meta_field = match tag {
                            b"publicPrivate" => MetaField::PublicPrivate,
                            b"docNumber" => MetaField::DocNumber,
                            b"citableAs" => MetaField::CitableAs,
                            b"approvedDate" => MetaField::ApprovedDate,
                            b"congress" => MetaField::Congress,
                            _ => MetaField::None,
                        };
                        meta_buf.clear();
                    }
                    _ if in_plaw && in_main => {
                        handle_start_main(
                            tag,
                            &e,
                            depth,
                            &mut block_stack,
                            &mut law_blocks,
                            &mut source_page,
                            &mut in_ref,
                            &mut ref_href,
                        );
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.local_name();
                let tag = name.as_ref();

                if skip_depth.map(|d| depth >= d).unwrap_or(false) {
                    buf.clear();
                    continue;
                }

                if in_plaw && in_main && tag == b"page" {
                    // Capture first page identifier as source_page
                    if source_page.is_empty() {
                        if let Some(id) = attr_value(&e, b"identifier") {
                            source_page = id;
                        }
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if skip_depth.map(|d| depth >= d).unwrap_or(false) {
                    buf.clear();
                    continue;
                }
                let text = e.unescape().unwrap_or_default().into_owned();

                if in_plaw && in_meta {
                    meta_buf.push_str(&text);
                } else if in_plaw && in_main {
                    if in_ref {
                        ref_text_buf.push_str(&text);
                    } else if let Some(builder) = block_stack.last_mut() {
                        builder.push_text(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let tag = name.as_ref();

                // Check skip zone exit
                if let Some(d) = skip_depth {
                    if depth == d {
                        skip_depth = None;
                    }
                    depth = depth.saturating_sub(1);
                    buf.clear();
                    continue;
                }

                depth = depth.saturating_sub(1);

                if !in_plaw {
                    buf.clear();
                    continue;
                }

                match tag {
                    b"pLaw" => {
                        // Flush any remaining builders
                        while let Some(builder) = block_stack.pop() {
                            if let Some(block) = builder.finish() {
                                law_blocks.push(block);
                            }
                        }

                        if public_private.to_lowercase() == "public" && !doc_number.is_empty() {
                            on_law(ParsedLaw {
                                public_law_number: format!("{}-{}", congress_str, doc_number),
                                stat_citation: stat_citation.clone(),
                                official_title: official_title.clone(),
                                approved_date: approved_date.clone(),
                                congress: congress_str.parse().unwrap_or(0),
                                blocks: std::mem::take(&mut law_blocks),
                                source_page: source_page.clone(),
                            });
                        }
                        in_plaw = false;
                        in_meta = false;
                        in_main = false;
                    }
                    b"meta" if in_meta => {
                        in_meta = false;
                    }
                    _ if in_meta => {
                        let val = meta_buf.trim().to_string();
                        match meta_field {
                            MetaField::PublicPrivate => public_private = val,
                            MetaField::DocNumber => doc_number = val,
                            MetaField::CitableAs => {
                                // Two citableAs values: "Public Law X-Y" and "N Stat. P"
                                if val.contains("Stat.") {
                                    stat_citation = val;
                                }
                            }
                            MetaField::ApprovedDate => approved_date = val,
                            MetaField::Congress => congress_str = val,
                            MetaField::None => {}
                        }
                        meta_field = MetaField::None;
                        meta_buf.clear();
                    }
                    b"officialTitle" if in_main => {
                        // Collect text already in stack's current inlines
                        if let Some(builder) = block_stack.last() {
                            official_title = builder.collect_text();
                        }
                    }
                    b"ref" if in_ref => {
                        in_ref = false;
                        let inline = make_ref_inline(&ref_href, &ref_text_buf);
                        if let Some(builder) = block_stack.last_mut() {
                            builder.push_inline(inline);
                        }
                        ref_href.clear();
                        ref_text_buf.clear();
                    }
                    _ if in_main => {
                        handle_end_main(tag, &mut block_stack, &mut law_blocks);
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("USLM parse error: {e}");
                break;
            }
        }
        buf.clear();
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Block builder
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum BuilderKind {
    Para,
    Heading { level: u8 },
    Outline { marker: String },
    Action,
    Quoted,
    Ignored, // collect nothing
}

#[derive(Debug)]
struct BlockBuilder {
    kind: BuilderKind,
    inlines: Vec<Inline>,
    children: Vec<Block>, // for Quoted
}

impl BlockBuilder {
    fn new(kind: BuilderKind) -> Self {
        Self {
            kind,
            inlines: Vec::new(),
            children: Vec::new(),
        }
    }

    fn push_text(&mut self, text: &str) {
        if self.kind == BuilderKind::Ignored {
            return;
        }
        let normalized = normalize_whitespace(text);
        if normalized.is_empty() {
            return;
        }
        // Append to last Text inline or create new one
        match self.inlines.last_mut() {
            Some(Inline::Text(t)) => t.push_str(&normalized),
            _ => self.inlines.push(Inline::Text(normalized)),
        }
    }

    fn push_inline(&mut self, inline: Inline) {
        if self.kind != BuilderKind::Ignored {
            self.inlines.push(inline);
        }
    }

    fn collect_text(&self) -> String {
        self.inlines
            .iter()
            .map(|i| match i {
                Inline::Text(t) => t.as_str(),
                Inline::Link { text, .. } => text.as_str(),
            })
            .collect()
    }

    fn finish(self) -> Option<Block> {
        match self.kind {
            BuilderKind::Ignored => None,
            BuilderKind::Para => {
                if self.inlines.is_empty() {
                    None
                } else {
                    Some(Block::Para(self.inlines))
                }
            }
            BuilderKind::Heading { level } => {
                if self.inlines.is_empty() {
                    None
                } else {
                    Some(Block::Heading {
                        level,
                        inlines: self.inlines,
                    })
                }
            }
            BuilderKind::Outline { marker } => {
                if self.inlines.is_empty() {
                    None
                } else {
                    Some(Block::Outline {
                        marker,
                        inlines: self.inlines,
                    })
                }
            }
            BuilderKind::Action => {
                if self.inlines.is_empty() {
                    None
                } else {
                    Some(Block::Action(self.inlines))
                }
            }
            BuilderKind::Quoted => {
                if self.children.is_empty() {
                    None
                } else {
                    Some(Block::Quoted(self.children))
                }
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Start/End handlers for <main> subtree
// ──────────────────────────────────────────────────────────────────────────────

fn handle_start_main(
    tag: &[u8],
    e: &quick_xml::events::BytesStart,
    _depth: usize,
    block_stack: &mut Vec<BlockBuilder>,
    _law_blocks: &mut Vec<Block>,
    source_page: &mut String,
    in_ref: &mut bool,
    ref_href: &mut String,
) {
    match tag {
        b"longTitle" | b"enactingFormula" => {
            block_stack.push(BlockBuilder::new(BuilderKind::Para));
        }
        b"title" => {
            // <title> within a law = a titled division (Title I, II…)
            block_stack.push(BlockBuilder::new(BuilderKind::Heading { level: 2 }));
        }
        b"section" => {
            block_stack.push(BlockBuilder::new(BuilderKind::Heading { level: 3 }));
        }
        b"subsection" | b"paragraph" | b"subparagraph" | b"clause" | b"subclause" | b"item"
        | b"subitem" => {
            block_stack.push(BlockBuilder::new(BuilderKind::Outline {
                marker: String::new(), // filled when <num> closes
            }));
        }
        b"action" => {
            block_stack.push(BlockBuilder::new(BuilderKind::Action));
        }
        b"quotedContent" | b"quotedText" => {
            // quotedText is inline; quotedContent is a block
            block_stack.push(BlockBuilder::new(BuilderKind::Quoted));
        }
        b"ref" => {
            *in_ref = true;
            *ref_href = attr_value(e, b"href").unwrap_or_default();
        }
        b"page" => {
            if source_page.is_empty() {
                if let Some(id) = attr_value(e, b"identifier") {
                    *source_page = id;
                }
            }
            // page elements are empty or contain text we don't want
        }
        // Collect text from these inline/structural elements into parent
        b"num" | b"heading" | b"content" | b"chapeau" | b"continuation" | b"actionDescription"
        | b"officialTitle" | b"docTitle" | b"i" | b"b" | b"inline" | b"shortTitle" => {
            // no new builder; text goes into current builder
        }
        // Skip sidenotes, toc, indexes, front/back matter
        b"sidenote"
        | b"toc"
        | b"subjectIndex"
        | b"index"
        | b"backMatter"
        | b"listOfPublicLaws"
        | b"listOfPrivateLaws"
        | b"listOfBillsEnacted"
        | b"listOfConcurrentResolutions"
        | b"listOfProclamations"
        | b"organizationNote"
        | b"explanationNote"
        | b"authority"
        | b"note"
        | b"coverTitle"
        | b"p"
        | b"referenceItem"
        | b"headingItem"
        | b"groupItem"
        | b"figure"
        | b"img" => {
            block_stack.push(BlockBuilder::new(BuilderKind::Ignored));
        }
        _ => {
            // Unknown elements: don't push a builder; text will land in parent
        }
    }
}

fn handle_end_main(tag: &[u8], block_stack: &mut Vec<BlockBuilder>, law_blocks: &mut Vec<Block>) {
    match tag {
        b"longTitle" | b"enactingFormula" | b"title" | b"section" | b"subsection"
        | b"paragraph" | b"subparagraph" | b"clause" | b"subclause" | b"item" | b"subitem"
        | b"action" | b"quotedContent" | b"quotedText" => {
            if let Some(builder) = block_stack.pop() {
                if let Some(block) = builder.finish() {
                    // Push finished block into parent or law_blocks
                    if let Some(parent) = block_stack.last_mut() {
                        if parent.kind == BuilderKind::Quoted {
                            parent.children.push(block);
                        } else {
                            // Render inline into parent as text
                            push_block_inline(block, parent);
                        }
                    } else {
                        law_blocks.push(block);
                    }
                }
            }
        }
        b"num" => {
            // Transfer collected text to the Outline marker
            if let Some(builder) = block_stack.last_mut() {
                let text = builder.collect_text().trim().to_string();
                builder.inlines.clear();
                if let BuilderKind::Outline { ref mut marker } = builder.kind {
                    *marker = text;
                }
            }
        }
        b"sidenote"
        | b"toc"
        | b"subjectIndex"
        | b"index"
        | b"backMatter"
        | b"listOfPublicLaws"
        | b"listOfPrivateLaws"
        | b"listOfBillsEnacted"
        | b"listOfConcurrentResolutions"
        | b"listOfProclamations"
        | b"organizationNote"
        | b"explanationNote"
        | b"authority"
        | b"note"
        | b"coverTitle"
        | b"p"
        | b"referenceItem"
        | b"headingItem"
        | b"groupItem"
        | b"figure"
        | b"img" => {
            block_stack.pop();
        }
        _ => {}
    }
}

/// When a finished block needs to be flattened into a parent builder's inlines.
fn push_block_inline(block: Block, parent: &mut BlockBuilder) {
    match block {
        Block::Para(inlines)
        | Block::Heading { inlines, .. }
        | Block::Outline { inlines, .. }
        | Block::Action(inlines) => {
            for inline in inlines {
                parent.inlines.push(inline);
            }
        }
        Block::Quoted(children) => {
            for child in children {
                push_block_inline(child, parent);
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum MetaField {
    None,
    PublicPrivate,
    DocNumber,
    CitableAs,
    ApprovedDate,
    Congress,
}

fn attr_value(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<String> {
    e.attributes()
        .filter_map(|a| a.ok())
        .find(|a| a.key.local_name().as_ref() == name)
        .and_then(|a| a.unescape_value().ok())
        .map(|v| v.into_owned())
}

fn normalize_whitespace(s: &str) -> String {
    // Collapse all whitespace sequences to single space, preserve newline structure
    let mut result = String::with_capacity(s.len());
    let mut last_was_space = false;
    for ch in s.chars() {
        if ch == '\n' || ch == '\r' {
            if !last_was_space {
                result.push(' ');
                last_was_space = true;
            }
        } else if ch.is_whitespace() {
            if !last_was_space {
                result.push(' ');
                last_was_space = true;
            }
        } else {
            result.push(ch);
            last_was_space = false;
        }
    }
    result
}

/// Convert a USLM `/us/usc/tN/sX` href to an internal link path.
fn usc_href_to_path(href: &str) -> Option<String> {
    // Pattern: /us/usc/t{titleNum}/s{sectionNum}
    let rest = href.strip_prefix("/us/usc/")?;
    let rest = rest.strip_prefix('t')?;
    let slash = rest.find('/')?;
    let title_num = &rest[..slash];
    let rest = &rest[slash + 1..];
    let section_num = rest.strip_prefix('s')?;
    // Strip any subsection qualifiers (e.g. "8901/a" → "8901")
    let section_num = section_num.split('/').next().unwrap_or(section_num);
    Some(format!("/usc/title-{}/section-{}", title_num, section_num))
}

fn make_ref_inline(href: &str, text: &str) -> Inline {
    let text = text.trim().to_string();
    match usc_href_to_path(href) {
        Some(path) => Inline::Link { text, href: path },
        None => Inline::Text(text),
    }
}
