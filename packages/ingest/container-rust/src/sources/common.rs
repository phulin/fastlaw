use crate::types::ContentBlock;

pub fn capitalize_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Create a body ContentBlock, setting content to None if the text is empty/whitespace.
pub fn body_block(text: &str) -> ContentBlock {
    ContentBlock {
        type_: "body".to_string(),
        label: None,
        content: if text.trim().is_empty() {
            None
        } else {
            Some(text.to_string())
        },
    }
}

/// Push a content block if the value is non-empty. Optionally transforms the content
/// (e.g. for inlining cross-references).
pub fn push_block(
    blocks: &mut Vec<ContentBlock>,
    type_: &str,
    label: &str,
    value: Option<String>,
    transform: Option<&dyn Fn(&str) -> String>,
) {
    if let Some(content) = value {
        let rendered = match transform {
            Some(f) => f(&content),
            None => content,
        };
        if !rendered.trim().is_empty() {
            blocks.push(ContentBlock {
                type_: type_.to_string(),
                label: Some(label.to_string()),
                content: Some(rendered),
            });
        }
    }
}
