# `xmlspec` User Guide

This guide documents the current `xmlspec` DSL/runtime in:

- `src/xmlspec.rs`
- `xmlspec-macros/src/lib.rs`

## Overview

`xmlspec` is a streaming XML extraction system:

- one-pass parse over `quick-xml`
- no DOM
- schema-specific codegen via `xmlspec!`

```rust
use usc_ingest::xmlspec::Engine;

usc_ingest::xmlspec! {
    schema DemoSchema {
        record SectionData
        from tag("section")
        where and(not(ancestor(tag("note"))), parent(tag("doc")))
        {
            heading: first_text() where and(tag("heading"), parent(tag("section"))),
            num: first_text() where and(tag("num"), parent(tag("section"))),
            notes: all_text() where tag("note"),
            kind: attr("kind") where tag("section"),
        }
    }
}

let mut engine = Engine::<DemoSchema>::new();
let mut out = Vec::new();
engine.parse_str(xml, |record| out.push(record))?;
```

## DSL

### Top level

```rust
xmlspec! {
    schema <SchemaName> {
        <record>*
    }
}
```

### Record

```rust
record <RecordName>
from tag("<root-tag>", ...)
where <selector> // optional; defaults to true
{
    <field-name>: <reducer> where <selector>,
}
```

`from` is structural and only accepts `tag(...)`.

### Reducers

- `first_text()` -> `Option<String>`
- `all_text()` -> `Vec<String>`
- `attr("<name>")` -> `Option<String>`
- `all_fragments()` -> `Vec<<GeneratedFragmentEnum>>`

`all_fragments()` supports inline mapping:

```rust
body: all_fragments()
    where tag("p")
    inline {
        tag("heading") => Bold,
        tag("i") => Italic,
    },
```

Generated fragment enum shape:

```rust
enum <Record><field>Fragment {
    Text(String),
    Bold(String),
    Italic(String),
}
```

### Selector language

Supported selectors:

- `tag("x", "y", ...)`
- `ancestor(<selector>)`
- `parent(<selector>)`
- `has_attr("name")`
- `attr_is("name", "value")`
- `and(<selector>, <selector>, ...)`
- `or(<selector>, <selector>, ...)`
- `not(<selector>)`
- `true()`

Restrictions:

- `ancestor(...)` and `parent(...)` arguments must be reducible to tag checks (`tag(...)` or `or(tag(...), ...)`).
- inline rules for `all_fragments()` must also be tag-reducible selectors.

## Runtime semantics

- Root candidates are bucketed by tag.
- `where` is evaluated on root start.
- Field selectors are evaluated on each `Start` event while scope is active.
- Text reducers consume both text nodes and CDATA.
- Text normalization collapses whitespace and trims.
- Scope emits exactly once at matching end tag.

## Generated items

For `schema DemoSchema`, macro expansion generates:

- `DemoSchema`
- `DemoSchemaTag`
- `DemoSchemaScope`
- `DemoSchemaOutput`
- one output struct per record
- fragment enums for `all_fragments()` fields

## Tests

Primary coverage:

- `tests/xmlspec_macro_tests.rs`
- `tests/xmlspec_engine_tests.rs`
- `tests/trybuild_xmlspec.rs`
- `tests/ui/xmlspec/pass/`
- `tests/ui/xmlspec/fail/`
