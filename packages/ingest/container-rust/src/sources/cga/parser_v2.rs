// Temporary file to develop new parser approach
use regex::Regex;
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentTarget {
    Body,
    HistoryShort,
    HistoryLong,
    Citations,
    SeeAlso,
}

struct ParseState {
    sections: Vec<SectionData>,
    current_section_index: Option<usize>,
    in_script_or_style: bool,
    skip_depth: usize, // Combined depth for catchln and nav_tbl
    current_target: ContentTarget,
    toc_map: BTreeMap<String, String>,
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

fn test_approach() {
    let html = r#"
        <span class="catchln" id="sec_1">Sec. 1. Title</span>
        <p>Body text</p>
        <table class="nav_tbl"><tr><td>Nav</td></tr></table>
    "#;

    let dom = tl::parse(html, tl::ParserOptions::default()).unwrap();
    let parser = dom.parser();

    // Build parent-child map
    let mut is_descendant_of_skip = vec![false; dom.nodes().len()];

    for (index, node) in dom.nodes().iter().enumerate() {
        if let Some(tag) = node.as_tag() {
            let classes: HashSet<String> = tag
                .attributes()
                .class()
                .map(|c| c.as_utf8_str().as_ref())
                .unwrap_or("")
                .split_whitespace()
                .map(ToString::to_string)
                .collect();

            let should_skip = (tag.name() == "span" && classes.contains("catchln"))
                || (tag.name() == "table" && classes.contains("nav_tbl"));

            if should_skip {
                // Mark all descendants
                // In tl's flat representation, descendants come after parent
                // We need to mark until we find a node that's not a descendant
                mark_descendants(&dom, index, &mut is_descendant_of_skip);
            }
        }
    }

    println!("Skip map: {:?}", is_descendant_of_skip);
}

fn mark_descendants(dom: &tl::VDom, parent_index: usize, skip_map: &mut Vec<bool>) {
    let parser = dom.parser();
    let parent_handle = tl::NodeHandle::new(parent_index as u32);
    let Some(parent_node) = parent_handle.get(parser) else {
        return;
    };
    let Some(parent_tag) = parent_node.as_tag() else {
        return;
    };

    // Get all children and recursively mark them
    fn mark_recursive(
        dom: &tl::VDom,
        handle: tl::NodeHandle,
        skip_map: &mut Vec<bool>,
    ) {
        let parser = dom.parser();
        let Some(node) = handle.get(parser) else {
            return;
        };

        // Mark this node
        skip_map[handle.get_inner() as usize] = true;

        // Recurse into children if it's a tag
        if let Some(tag) = node.as_tag() {
            for child in tag.children().top().iter() {
                mark_recursive(dom, *child, skip_map);
            }
        }
    }

    // Mark all children
    for child in parent_tag.children().top().iter() {
        mark_recursive(dom, *child, skip_map);
    }
}
