use crate::sources::uspl::parser::{Block, Inline, ParsedLaw};

/// Render a `ParsedLaw` to a single markdown string.
pub fn law_to_markdown(law: &ParsedLaw) -> String {
    let mut out = String::new();

    for block in &law.blocks {
        render_block(block, &mut out);
        out.push('\n');
    }

    // Append approval date if present and not already in an Action block
    if !law.approved_date.is_empty() && !out.contains(&law.approved_date) {
        out.push_str(&format!("\n*Approved {}.*\n", law.approved_date));
    }

    out.trim().to_string()
}

fn render_block(block: &Block, out: &mut String) {
    match block {
        Block::Para(inlines) => {
            let text = render_inlines(inlines);
            if !text.trim().is_empty() {
                out.push('\n');
                out.push_str(text.trim());
                out.push('\n');
            }
        }
        Block::Heading { level, inlines } => {
            let text = render_inlines(inlines);
            let text = text.trim();
            if !text.is_empty() {
                out.push('\n');
                let hashes = "#".repeat(*level as usize);
                out.push_str(&format!("{} {}\n", hashes, text));
            }
        }
        Block::Outline { marker, inlines } => {
            let text = render_inlines(inlines);
            let text = text.trim();
            if !text.is_empty() {
                out.push('\n');
                if marker.is_empty() {
                    out.push_str(text);
                } else {
                    out.push_str(&format!("**{}** {}", marker, text));
                }
                out.push('\n');
            }
        }
        Block::Action(inlines) => {
            let text = render_inlines(inlines);
            let text = text.trim();
            if !text.is_empty() {
                out.push_str(&format!("\n*{}*\n", text));
            }
        }
        Block::Quoted(children) => {
            out.push('\n');
            for child in children {
                let mut child_out = String::new();
                render_block(child, &mut child_out);
                for line in child_out.lines() {
                    out.push_str("> ");
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
}

fn render_inlines(inlines: &[Inline]) -> String {
    let mut out = String::new();
    for inline in inlines {
        match inline {
            Inline::Text(t) => out.push_str(t),
            Inline::Link { text, href } => {
                out.push_str(&format!("[{}]({})", text, href));
            }
        }
    }
    out
}
