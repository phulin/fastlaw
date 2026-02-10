# Streaming XML Extraction Engine (`xmlspec!`)

## Design Document

### Status

Proposed / Ready for implementation

---

## 1. Motivation

We need a **high-performance, streaming XML ingestion system** in Rust that:

* Operates in **one pass** over XML (`quick-xml`)
* Uses **bounded memory**
* Achieves **near-manual state machine performance**
* Avoids:

  * DOM construction
  * XPath engines
  * runtime matcher graphs
* Allows users to **declaratively specify what to extract**, without writing per-schema state machines

The target domain includes:

* statutory text
* regulations
* hierarchical legal documents
* large XML files (tens to hundreds of MB)

This system is **not** a general XML query engine. It is an **ingestion compiler**.

---

## 2. Core Idea

Instead of interpreting XPath-like queries at runtime, we:

> **Compile a restricted, streaming-friendly “selection + extraction” specification into monomorphic Rust code that runs directly on XML tokens.**

Key principles:

1. **Genericity at compile time, not runtime**
2. **Static tag identity**
3. **Streaming reducers instead of tree queries**
4. **Scopes instead of global state machines**

---

## 3. Architectural Overview

```
┌─────────────────────────────────────┐
│ xmlspec! schema definition (eDSL)   │
│                                     │
│ record SectionData { … }             │
└───────────────┬─────────────────────┘
                │ macro expansion
┌───────────────▼─────────────────────┐
│ Schema module (generated code)       │
│ - Tag enum                           │
│ - tag interner                       │
│ - scope structs                      │
│ - reducer logic                      │
│ - root matcher specs                 │
└───────────────┬─────────────────────┘
                │ used by
┌───────────────▼─────────────────────┐
│ Generic streaming engine             │
│ - XML event loop                     │
│ - tag stack                          │
│ - depth counters                     │
│ - active scopes                      │
└─────────────────────────────────────┘
```

---

## 4. Runtime Model

### 4.1 XML Event Stream

We consume `quick-xml` events:

* `Start`
* `Text`
* `CData`
* `End`

The engine never buffers the document.

---

### 4.2 Tag Interning

All tag names are mapped to a **schema-local enum**.

```rust
enum Tag {
    Section,
    Note,
    Heading,
    Num,
}
```

At runtime:

* byte slice → `Option<Tag>`
* no strings or allocations in the hot path

Each schema chooses its own interning strategy:

* `match` on literals (preferred)
* `phf`
* fallback hash map (discouraged)

---

### 4.3 Stack and Depth Counters

We maintain:

```rust
stack: Vec<Tag>
depths: Vec<u32>   // indexed by Tag
```

This enables:

* `ancestor(x)` → `depths[x] > 0`
* `parent(x)` → `stack[stack.len() - 2] == x`

No tree structure is ever built.

---

## 5. Scopes

### 5.1 What Is a Scope?

A **scope** represents a matched subtree that will emit exactly one output record.

Example:

```text
<section> ... </section> → SectionData
```

Scopes are:

* created on `Start(root_tag)` if guard passes
* active until matching `End(root_tag)`
* may nest (rare but supported)

---

### 5.2 Scope Structure

Each scope contains:

* reducer state (text buffers, flags)
* output fields
* no dynamic dispatch

Example:

```rust
struct SectionScope {
    heading_done: bool,
    heading_buf: Vec<u8>,
    heading: Option<String>,

    notes_buf: Vec<u8>,
    notes: Vec<String>,
}
```

---

## 6. Reducers (Extraction Semantics)

Reducers are **compiled streaming reductions**, not runtime objects.

### 6.1 Supported Reducers

| Reducer      | Meaning                                  |
| ------------ | ---------------------------------------- |
| `first_text` | capture text from first matching element |
| `all_text`   | capture text from all matching elements  |
| `attr`       | capture attribute value                  |

Reducers operate only while a scope is active.

---

### 6.2 Selector Semantics

Reducers listen to events defined by selectors:

| Selector     | Meaning                           |
| ------------ | --------------------------------- |
| `desc("x")`  | any descendant `<x>` within scope |
| `child("x")` | direct child of scope root        |

---

### 6.3 Text Capture Rules

* `Text` and `CData` both count
* Text may arrive in multiple chunks
* Buffers are reused
* Conversion to `String` happens only at finalization

---

## 7. Guards (Root Filters)

Guards determine whether a scope opens.

### 7.1 Supported Guard Primitives

* `ancestor(tag)`
* `parent(tag)`
* `not(expr)`
* `and`, `or`
* `true`

Example:

```rust
where not(ancestor("note"))
```

---

### 7.2 Guard Evaluation

Guards compile to **inline boolean checks**:

```rust
depths[Tag::Note] == 0
```

No closures, no function pointers.

---

## 8. Engine Core (Generic)

The engine is generic over tag sets.

```rust
trait TagSet {
    type Tag: Copy + Eq;
    fn intern(bytes: &[u8]) -> Option<Self::Tag>;
}
```

```rust
struct Engine<TS: TagSet> {
    stack: Vec<TS::Tag>,
    depths: Vec<u32>,
    scopes: Vec<Scope<TS>>,
    roots: &'static [RootSpec<TS::Tag>],
}
```

### 8.1 Hot Path Guarantees

* O(1) per event
* No heap allocation unless capturing text
* No string comparisons
* No hash maps
* No dynamic dispatch

---

## 9. `xmlspec!` eDSL

### 9.1 High-Level Syntax

```rust
xmlspec! {
    schema Statutes {

        record SectionData
        from tag("section")
        where not(ancestor("note"))
        {
            title: first_text(desc("heading")),
            num:   first_text(desc("num")),
            notes: all_text(desc("note")),
        }

    }
}
```

---

### 9.2 Grammar (Formal Sketch)

```
xmlspec        := "xmlspec!" "{" schema "}"

schema         := "schema" IDENT "{" record* "}"

record         := "record" IDENT
                  "from" root_selector
                  guard?
                  "{" field* "}"

root_selector  := "tag" "(" STRING ")"

guard          := "where" guard_expr

guard_expr     := "true"
                | "ancestor" "(" STRING ")"
                | "parent" "(" STRING ")"
                | "not" "(" guard_expr ")"
                | guard_expr "and" guard_expr
                | guard_expr "or"  guard_expr

field          := IDENT ":" extractor ","

extractor      := "first_text" "(" selector ")"
                | "all_text" "(" selector ")"
                | "attr" "(" STRING ")"

selector       := "desc" "(" STRING ")"
                | "child" "(" STRING ")"
```

---

## 10. Compile-Time Guarantees

The macro ensures:

* All tags are statically known
* Tag enum is minimal
* Only necessary depth counters exist
* Reducers are concrete fields
* No runtime reflection

Invalid constructs fail at compile time.

---

## 11. Performance Characteristics

* Linear scan
* Near hand-written parser speed
* Scales to very large XML inputs
* Stable memory usage

This is intentionally **faster than SAX + user handler** for non-trivial extraction logic.

---

## 12. Extensibility Rules (Strict)

### Allowed Extensions

* New reducer types
* New guard primitives that map to O(1) checks
* New selectors that depend only on stack/depth

### Forbidden Extensions

* Arbitrary XPath
* Backward traversal
* Sibling iteration
* Position predicates
* Tree materialization

If an extension requires:

> “remembering past siblings” or “looking ahead”

…it does not belong here.

---

## 13. Transition Plan (From Existing Code)

### Phase 1 — Kill Matcher Graphs

* Replace `TrackingMatcher` with:

  * tag enum
  * stack
  * depth counters

### Phase 2 — Introduce Scopes

* Move handler logic into scope structs
* Emit records only on scope close

### Phase 3 — Reducers

* Replace ad-hoc text logic with reducer patterns

### Phase 4 — TagSet Genericity

* Make engine generic over tag sets
* Remove schema-specific logic from engine core

### Phase 5 — `xmlspec!` Macro

* Generate schema modules
* Lock API

Each phase yields performance and clarity improvements independently.

---

## 14. Mental Model for Users

> “I declare when a record starts, when it is allowed, and what I want to collect while I’m inside it.”

If something can’t be expressed that way, it probably violates streaming constraints.

---

## 15. Summary

This system:

* Is **generic across XML schemas**
* Preserves **streaming guarantees**
* Eliminates **runtime matching overhead**
* Compiles declarative specs into **tight Rust code**
* Scales to legal-scale datasets

It is intentionally narrow — and that narrowness is what makes it fast, safe, and maintainable.
