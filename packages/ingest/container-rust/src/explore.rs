use async_trait::async_trait;
use ingest::runtime::types::{
    BlobStore, BuildContext, Cache, IngestContext, Logger, NodeStore, QueueItem, UrlQueue,
};
use ingest::sources::cgs::adapter::CGS_ADAPTER;
use ingest::sources::mgl::adapter::MGL_ADAPTER;
use ingest::sources::rigl::adapter::RIGL_ADAPTER;
use ingest::sources::usc::adapter::USC_ADAPTER;
use ingest::sources::vt::adapter::VT_ADAPTER;
use ingest::sources::SourceAdapter;
use ingest::types::{NodePayload, SectionContent};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

type DynError = Box<dyn std::error::Error + Send + Sync + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceArg {
    Usc,
    Cgs,
    Mgl,
    Rigl,
    Vt,
}

impl SourceArg {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "usc" => Some(Self::Usc),
            "cgs" => Some(Self::Cgs),
            "mgl" => Some(Self::Mgl),
            "rigl" => Some(Self::Rigl),
            "vt" => Some(Self::Vt),
            _ => None,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        eprintln!("Usage: explore <usc|cgs|mgl|rigl|vt> <file> <needle>");
        std::process::exit(2);
    }

    let source =
        SourceArg::parse(&args[0]).ok_or("first argument must be usc, cgs, mgl, or rigl")?;
    let file_path = args[1].clone();
    let needle = args[2].clone();
    let input = std::fs::read_to_string(&file_path)?;

    let node_store = CaptureNodeStore::new();
    let queue = Arc::new(SimpleUrlQueue::new());
    let mut ctx = IngestContext {
        build: BuildContext {
            source_version_id: "explore",
            root_node_id: "root",
            accessed_at: "now",
            unit_sort_order: 0,
        },
        nodes: Box::new(node_store.clone()),
        blobs: Arc::new(NoopBlobStore),
        cache: Arc::new(NoopCache::new(&file_path, &input)),
        queue: queue.clone(),
        logger: Arc::new(ConsoleLogger),
    };

    let item = build_queue_item(source, &file_path);

    match source {
        SourceArg::Usc => USC_ADAPTER
            .process_url(&mut ctx, &item)
            .await
            .map_err(|e| format!("USC adapter process failed: {e}"))?,
        SourceArg::Cgs => CGS_ADAPTER
            .process_url(&mut ctx, &item)
            .await
            .map_err(|e| format!("CGS adapter process failed: {e}"))?,
        SourceArg::Mgl => MGL_ADAPTER
            .process_url(&mut ctx, &item)
            .await
            .map_err(|e| format!("MGL adapter process failed: {e}"))?,
        SourceArg::Rigl => RIGL_ADAPTER
            .process_url(&mut ctx, &item)
            .await
            .map_err(|e| format!("RIGL adapter process failed: {e}"))?,
        SourceArg::Vt => VT_ADAPTER
            .process_url(&mut ctx, &item)
            .await
            .map_err(|e| format!("VT adapter process failed: {e}"))?,
    }

    let nodes = node_store.nodes();
    let matches = nodes
        .iter()
        .filter(|node| {
            node.meta.id.contains(&needle)
                || node
                    .meta
                    .path
                    .as_deref()
                    .is_some_and(|path| path.contains(&needle))
                || node
                    .meta
                    .readable_id
                    .as_deref()
                    .is_some_and(|id| id.contains(&needle))
        })
        .collect::<Vec<_>>();

    if matches.is_empty() {
        println!("matches: []");
        return Ok(());
    }

    println!("matches:");
    for node in matches {
        print_node(&needle, node);
    }

    Ok(())
}

fn build_queue_item(source: SourceArg, file_path: &str) -> QueueItem {
    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match source {
        SourceArg::Usc => {
            let title_num = infer_digits(&file_name).unwrap_or_else(|| "42".to_string());
            QueueItem {
                url: file_path.to_string(),
                parent_id: "root".to_string(),
                level_name: "unit".to_string(),
                level_index: 0,
                metadata: json!({
                    "unit_id": format!("usc-{title_num}"),
                    "title_num": title_num,
                    "sort_order": 0
                }),
            }
        }
        SourceArg::Cgs => {
            let title_id =
                infer_title_id_from_text(&std::fs::read_to_string(file_path).unwrap_or_default())
                    .unwrap_or_else(|| "1".to_string());
            let chapter_id = infer_chapter_id(&file_name).unwrap_or_else(|| "1".to_string());
            let unit_kind = if file_name.starts_with("art_") {
                "article"
            } else {
                "chapter"
            };
            QueueItem {
                url: file_path.to_string(),
                parent_id: "root/title-1".to_string(),
                level_name: unit_kind.to_string(),
                level_index: 1,
                metadata: json!({
                    "unit_id": format!("cgs-{unit_kind}-{chapter_id}"),
                    "title_num": title_id,
                    "chapter_id": chapter_id,
                    "sort_order": 0
                }),
            }
        }
        SourceArg::Mgl => {
            let chapter_num = infer_chapter_num(&file_name).unwrap_or_else(|| "1".to_string());
            QueueItem {
                url: file_path.to_string(),
                parent_id: "root".to_string(),
                level_name: "unit".to_string(),
                level_index: 0,
                metadata: json!({
                    "unit_id": format!("mgl-chapter-{chapter_num}"),
                    "title_num": "I",
                    "sort_order": 0
                }),
            }
        }
        SourceArg::Rigl => {
            let title_num = infer_title_id(&file_name).unwrap_or_else(|| "1".to_string());
            let chapter_num =
                infer_chapter_num_from_rigl(&file_name).unwrap_or_else(|| "1-1".to_string());
            QueueItem {
                url: file_path.to_string(),
                parent_id: "root/title-1".to_string(),
                level_name: "section".to_string(),
                level_index: 2,
                metadata: json!({
                    "title_num": title_num,
                    "chapter_num": chapter_num,
                    "section_num": infer_section_num_from_rigl(&file_name).unwrap_or_else(|| "1-1-1".to_string()),
                    "sort_order": 0
                }),
            }
        }
        SourceArg::Vt => {
            let title_num = infer_title_num_from_vt(&file_name).unwrap_or_else(|| "02".to_string());
            let chapter_num =
                infer_chapter_num_from_vt(&file_name).unwrap_or_else(|| "001".to_string());
            QueueItem {
                url: file_path.to_string(),
                parent_id: format!("root/title-{}", title_num.to_ascii_lowercase()),
                level_name: "chapter".to_string(),
                level_index: 1,
                metadata: json!({
                    "title_num": title_num,
                    "title_display_num": "2",
                    "chapter_num": chapter_num,
                    "chapter_display_num": "1",
                    "sort_order": 0
                }),
            }
        }
    }
}

fn infer_digits(file_name: &str) -> Option<String> {
    let digits = file_name
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || c.is_ascii_alphabetic())
        .collect::<String>();

    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn infer_chapter_id(file_name: &str) -> Option<String> {
    if let Some(value) = file_name.strip_prefix("chap_") {
        return value.strip_suffix(".htm").map(ToString::to_string);
    }
    if let Some(value) = file_name.strip_prefix("art_") {
        return value.strip_suffix(".htm").map(ToString::to_string);
    }
    None
}

fn infer_chapter_num(file_name: &str) -> Option<String> {
    if let Some(value) = file_name.strip_prefix("mgl_chapter_") {
        return value.strip_suffix(".json").map(ToString::to_string);
    }
    if let Some(value) = file_name.strip_prefix("mgl_section_") {
        return value.strip_suffix(".json").map(ToString::to_string);
    }
    None
}

fn infer_title_id(file_name: &str) -> Option<String> {
    if let Some(value) = file_name.strip_prefix("title_") {
        return value.strip_suffix("_index.htm").map(ToString::to_string);
    }
    None
}

fn infer_chapter_num_from_rigl(file_name: &str) -> Option<String> {
    if let Some(value) = file_name.strip_prefix("chapter_") {
        return value.strip_suffix("_index.htm").map(ToString::to_string);
    }
    if let Some(value) = file_name.strip_prefix("section_") {
        let cleaned = value.strip_suffix(".htm")?;
        let mut segments = cleaned.split('-').collect::<Vec<_>>();
        if segments.len() >= 3 {
            segments.pop();
            return Some(segments.join("-"));
        }
    }
    None
}

fn infer_section_num_from_rigl(file_name: &str) -> Option<String> {
    file_name
        .strip_prefix("section_")
        .and_then(|value| value.strip_suffix(".htm"))
        .map(ToString::to_string)
}

fn infer_title_num_from_vt(file_name: &str) -> Option<String> {
    if let Some(value) = file_name.strip_prefix("title_") {
        return value.strip_suffix(".html").map(ToString::to_string);
    }
    if let Some(value) = file_name.strip_prefix("fullchapter_") {
        return value.split('_').next().map(ToString::to_string);
    }
    None
}

fn infer_chapter_num_from_vt(file_name: &str) -> Option<String> {
    if let Some(value) = file_name.strip_prefix("fullchapter_") {
        let mut parts = value.split('_');
        let _title = parts.next()?;
        return parts
            .next()
            .map(|part| part.trim_end_matches(".html").to_string());
    }
    None
}

fn infer_title_id_from_text(text: &str) -> Option<String> {
    let marker = "Sec. ";
    let index = text.find(marker)? + marker.len();
    let rest = &text[index..];
    let first = rest.split('.').next()?.trim();
    first.split('-').next().map(ToString::to_string)
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

struct SimpleUrlQueue {
    items: Mutex<VecDeque<QueueItem>>,
}

impl SimpleUrlQueue {
    fn new() -> Self {
        Self {
            items: Mutex::new(VecDeque::new()),
        }
    }
}

impl UrlQueue for SimpleUrlQueue {
    fn enqueue(&self, item: QueueItem) {
        self.items.lock().unwrap().push_back(item);
    }
}

struct NoopBlobStore;

#[async_trait]
impl BlobStore for NoopBlobStore {
    async fn store_blob(&self, id: &str, _content: &[u8]) -> Result<String, String> {
        Ok(id.to_string())
    }
}

struct NoopCache {
    file_path: String,
    content: String,
}

impl NoopCache {
    fn new(file_path: &str, content: &str) -> Self {
        Self {
            file_path: file_path.to_string(),
            content: content.to_string(),
        }
    }
}

#[async_trait]
impl Cache for NoopCache {
    async fn fetch_cached(&self, url: &str, _key: &str) -> Result<String, String> {
        if url == self.file_path {
            Ok(self.content.clone())
        } else {
            Err(format!("NoopCache cannot fetch: {}", url))
        }
    }
}

struct ConsoleLogger;

#[async_trait]
impl Logger for ConsoleLogger {
    async fn log(&self, level: &str, message: &str, _context: Option<serde_json::Value>) {
        eprintln!("[{}] {}", level.to_uppercase(), message);
    }
}

fn print_node(needle: &str, node: &NodePayload) {
    println!("  - needle: {needle}");
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
