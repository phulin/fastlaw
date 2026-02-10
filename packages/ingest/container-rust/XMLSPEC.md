# `xmlspec` User Guide

This guide documents how to use the `xmlspec` macro and runtime in:

- `src/xmlspec.rs`
- `xmlspec-macros/src/lib.rs`

## Overview

`xmlspec` is a streaming XML extraction system for Rust.

You define extraction rules declaratively:

```rust
usc_ingest::xmlspec! {
    schema DemoSchema {
        record SectionData
        from tag("section")
        where not(ancestor("note")) and parent("doc")
        {
            heading: first_text(desc("heading")),
            num: first_text(child("num")),
            notes: all_text(desc("note")),
            kind: attr("kind"),
        }
    }
}
```

Then run it with:

```rust
use usc_ingest::xmlspec::Engine;

let mut engine = Engine::<DemoSchema>::new();
let mut out = Vec::new();
engine.parse_str(xml, |record| out.push(record))?;
```

## What Gets Generated

For `schema DemoSchema`, the macro generates:

- `DemoSchema` (schema type implementing `Schema`)
- `DemoSchemaTag` (interned tag enum)
- `DemoSchemaScope` (internal scope enum)
- `DemoSchemaOutput` (output enum)
- One output struct per `record` (for example `SectionData`)

Important:

- Output enum is schema-specific (`<SchemaName>Output`) to avoid collisions across multiple schemas in one module.
- Record struct names are emitted at module scope. If two schemas in the same module use the same record name, that will still collide.

## DSL Reference

## Top Level

```rust
xmlspec! {
    schema <SchemaName> {
        <record>*
    }
}
```

## Record

```rust
record <RecordName>
from tag("<root-tag>")
where <guard-expr>   // optional, defaults to true
{
    <field-name>: <extractor>,
    ...
}
```

## Extractors

- `first_text(<selector>)` -> `Option<String>`
- `all_text(<selector>)` -> `Vec<String>`
- `attr("<attr-name>")` -> `Option<String>`

Notes:

- `attr(...)` currently captures the attribute from the **record root element** only.
- Text includes both XML text nodes and CDATA.

## Selectors

- `desc("tag")`: any descendant of record root
- `child("tag")`: direct child of record root

## Guards

- `true`
- `ancestor("tag")`
- `parent("tag")`
- `not(<expr>)`
- `<expr> and <expr>`
- `<expr> or <expr>`
- Parentheses are supported.

## Guard Semantics

Guards are evaluated when the record root start tag is seen.

- `ancestor("x")`: true if `x` exists in the open-tag stack above the current tag.
- `parent("x")`: true only if the immediate stack top equals `x` at guard time.

Important behavior with unknown tags:

- If the immediate XML parent tag is unknown to the schema tag set, `parent("...")` does **not** skip through it.
- This is covered by test `parent_guard_does_not_skip_unknown_wrappers` in:
  - `tests/xmlspec_macro_tests.rs`

## Runtime Model

- One pass over XML (`quick-xml`)
- No DOM tree
- Maintains:
  - stack of interned tags
  - depth counters per tag
  - active scope stack

Performance-relevant details:

- Root matching is bucketed by tag (no scan over all records for each start tag).
- Macro-generated schemas compile guard expressions into direct boolean checks (`view.parent(...)`, `view.ancestor(...)`) instead of traversing a runtime guard tree.

## Full Example

```rust
use usc_ingest::xmlspec::Engine;

usc_ingest::xmlspec! {
    schema NotesSchema {
        record SectionRecord
        from tag("section")
        where not(ancestor("note"))
        {
            num: first_text(child("num")),
            heading: first_text(desc("heading")),
            notes: all_text(desc("note")),
            kind: attr("kind"),
        }
    }
}

fn run(xml: &str) -> Result<Vec<SectionRecord>, quick_xml::Error> {
    let mut engine = Engine::<NotesSchema>::new();
    let mut out = Vec::new();
    engine.parse_str(xml, |record| {
        if let NotesSchemaOutput::SectionRecord(section) = record {
            out.push(section);
        }
    })?;
    Ok(out)
}
```

## Testing Strategy

Recommended tests:

- Runtime behavior tests:
  - `tests/xmlspec_macro_tests.rs`
  - `tests/xmlspec_engine_tests.rs`
- Compile-pass/fail DSL tests:
  - `tests/trybuild_xmlspec.rs`
  - `tests/ui/xmlspec/pass/`
  - `tests/ui/xmlspec/fail/`

Run:

```bash
cargo test
```

## Common Errors

## `expected first_text(...), all_text(...), or attr("...")`

Cause: unsupported extractor name.

Fix: use exactly one of:

- `first_text(...)`
- `all_text(...)`
- `attr("...")`

## `only true is allowed in guard expressions`

Cause: `where false` is not supported.

Fix:

- remove guard (`where` omitted defaults to `true`)
- or use supported boolean expressions built from `ancestor`, `parent`, `not`, `and`, `or`.

## Design vs Current Implementation

Current implementation is aligned with the design’s core goals:

- streaming extraction
- compile-time schema typing
- no XPath / no DOM

Current practical constraints:

- Input source is currently `parse_str` (string-based)
- `attr(...)` is root-attribute-only
- guard primitives are limited to documented set
- selector set is `desc` and `child` only

These constraints are deliberate for predictable performance and simpler codegen.
