use async_trait::async_trait;
use ingest::runtime::types::{BlobStore, BuildContext, IngestContext, NodeStore};
use ingest::sources::usc::adapter::USC_ADAPTER;
use ingest::sources::SourceAdapter;
use ingest::types::{NodePayload, SectionContent, UnitEntry};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

type DynError = Box<dyn std::error::Error + Send + Sync + 'static>;

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        eprintln!("Usage: explore <xml_file> <identifier_substring>");
        std::process::exit(2);
    }

    let xml_path = args.remove(0);
    let needle = args.remove(0);
    let xml = std::fs::read_to_string(&xml_path)?;

    let matched_identifiers = find_matching_identifiers(&xml, &needle)?;
    if matched_identifiers.is_empty() {
        println!("matches: []");
        return Ok(());
    }

    let title_num = infer_title_num(&matched_identifiers)
        .unwrap_or_else(|| infer_title_num_from_path(&xml_path));

    let node_store = CaptureNodeStore::new();
    let mut ctx = IngestContext {
        build: BuildContext {
            source_version_id: "explore",
            root_node_id: "root",
            accessed_at: "now",
            unit_sort_order: 0,
        },
        nodes: Box::new(node_store.clone()),
        blobs: Box::new(NoopBlobStore),
    };

    let unit = UnitEntry {
        unit_id: format!("usc-{title_num}"),
        url: xml_path.clone(),
        sort_order: 0,
        payload: json!({ "titleNum": title_num }),
    };

    USC_ADAPTER
        .process_unit(&unit, &mut ctx, &xml)
        .await
        .map_err(|e| format!("adapter process failed: {e}"))?;

    let nodes = node_store.nodes();

    println!("matches:");
    for identifier in matched_identifiers {
        let matched = nodes
            .iter()
            .filter(|node| node_matches_identifier(node, &identifier, ctx.build.root_node_id))
            .collect::<Vec<_>>();

        if matched.is_empty() {
            println!("  - identifier: {identifier}");
            println!("    error: \"no adapter node matched this identifier\"");
            continue;
        }

        for node in matched {
            print_node(identifier.as_str(), node);
        }
    }

    Ok(())
}

#[derive(Clone)]
struct CaptureNodeStore {
    nodes: Arc<Mutex<Vec<NodePayload>>>,
}

impl CaptureNodeStore {
    fn new() -> Self {
        Self {
            nodes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn nodes(&self) -> Vec<NodePayload> {
        self.nodes.lock().expect("node lock poisoned").clone()
    }
}

#[async_trait]
impl NodeStore for CaptureNodeStore {
    async fn insert_node(&self, node: NodePayload) -> Result<(), String> {
        self.nodes
            .lock()
            .map_err(|_| "node lock poisoned".to_string())?
            .push(node);
        Ok(())
    }

    async fn flush(&self) -> Result<(), String> {
        Ok(())
    }
}

struct NoopBlobStore;

#[async_trait]
impl BlobStore for NoopBlobStore {
    async fn store_blob(&self, id: &str, _content: &[u8]) -> Result<String, String> {
        Ok(id.to_string())
    }
}

fn find_matching_identifiers(xml: &str, needle: &str) -> Result<Vec<String>, DynError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();
    let mut matches = BTreeSet::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() != b"identifier" {
                        continue;
                    }
                    let value = decode_attr_value(attr.value);
                    if value.contains(needle) {
                        matches.insert(value);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(err) => return Err(Box::new(err)),
        }
        buf.clear();
    }

    if matches.contains(needle) {
        return Ok(vec![needle.to_string()]);
    }

    Ok(matches.into_iter().collect())
}

fn decode_attr_value(bytes: Cow<'_, [u8]>) -> String {
    std::str::from_utf8(&bytes)
        .ok()
        .and_then(|s| quick_xml::escape::unescape(s).ok())
        .map(|c| c.into_owned())
        .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn infer_title_num(identifiers: &[String]) -> Option<String> {
    identifiers.iter().find_map(|id| {
        let marker = "/t";
        let start = id.find(marker)? + marker.len();
        let rest = &id[start..];
        let end = rest.find('/').unwrap_or(rest.len());
        let candidate = &rest[..end];
        if candidate.is_empty() {
            None
        } else {
            Some(candidate.to_string())
        }
    })
}

fn infer_title_num_from_path(path: &str) -> String {
    let filename = std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    let digits = filename
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || c.is_ascii_alphabetic())
        .collect::<String>();

    if digits.is_empty() {
        "42".to_string()
    } else {
        digits
    }
}

fn node_matches_identifier(node: &NodePayload, identifier: &str, root_id: &str) -> bool {
    if let Some(section_num) = section_num_from_identifier(identifier) {
        if let Some(title_num) = title_num_from_identifier(identifier) {
            let section_path = format!(
                "/statutes/usc/section/{}/{}",
                title_num,
                normalize_section_num(&section_num)
            );
            if node.meta.path.as_deref() == Some(section_path.as_str()) {
                return true;
            }
        }
    }

    if let Some(native_id) = identifier.strip_prefix("/us/usc/") {
        let direct_level_id = format!("{root_id}/{native_id}");
        if node.meta.id == direct_level_id {
            return true;
        }

        if let Some(title_num) = title_num_from_identifier(identifier) {
            let title_root_id = format!("{root_id}/t{title_num}/root");
            if node.meta.id == title_root_id && native_id == format!("t{title_num}") {
                return true;
            }
        }
    }

    false
}

fn title_num_from_identifier(identifier: &str) -> Option<String> {
    let marker = "/t";
    let start = identifier.find(marker)? + marker.len();
    let rest = &identifier[start..];
    let end = rest.find('/').unwrap_or(rest.len());
    let title_num = &rest[..end];
    if title_num.is_empty() {
        None
    } else {
        Some(title_num.to_string())
    }
}

fn section_num_from_identifier(identifier: &str) -> Option<String> {
    identifier
        .rsplit('/')
        .next()
        .and_then(|part| part.strip_prefix('s'))
        .map(ToString::to_string)
}

fn normalize_section_num(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}'
            ) {
                '-'
            } else {
                ch
            }
        })
        .collect()
}

fn print_node(identifier: &str, node: &NodePayload) {
    println!("  - identifier: {identifier}");
    println!("    node_id: {}", node.meta.id);
    println!("    metadata_json: |-");
    let meta_value = serde_json::to_value(&node.meta).unwrap_or_else(|_| json!({}));
    print_indented_json(&meta_value, 6);

    if let Some(content) = &node.content {
        let parsed_content = serde_json::from_value::<SectionContent>(content.clone());
        if let Ok(section_content) = parsed_content {
            if let Some(metadata) = &section_content.metadata {
                println!("    content_metadata_json: |-");
                let content_meta_value =
                    serde_json::to_value(metadata).unwrap_or_else(|_| json!({}));
                print_indented_json(&content_meta_value, 6);
            }
            println!("    markdown_blocks:");
            for block in &section_content.blocks {
                println!("      - type: {}", block.type_);
                if let Some(label) = &block.label {
                    println!("        label: {label}");
                } else {
                    println!("        label: null");
                }
                if let Some(content) = &block.content {
                    println!("        content: |-");
                    if content.is_empty() {
                        println!("          ");
                    } else {
                        for line in content.lines() {
                            println!("          {line}");
                        }
                    }
                } else {
                    println!("        content: null");
                }
            }
            return;
        }
    }

    println!("    markdown_blocks: []");
}

fn print_indented_json(value: &Value, indent: usize) {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    let pad = " ".repeat(indent);
    for line in pretty.lines() {
        println!("{pad}{line}");
    }
}
