# `xmlspec!`: A Streaming XML Selection, Extraction, and Inline Transformation System

## Design Document

### Status

Authoritative design / Ready for implementation

---

## 1. Overview

`xmlspec!` is a **compile-time specification language** and **runtime engine** for high-performance XML ingestion in Rust.

It is designed to:

* Process XML in **a single streaming pass**
* Operate with **bounded memory**
* Achieve **near hand-written parser performance**
* Avoid:

  * DOM construction
  * XPath engines
  * runtime matcher graphs
* Allow declarative, schema-specific extraction logic
* Support **inline structural transformations** into typed fragments

This system is intentionally *not* a general-purpose XML query language. It is a **streaming ingestion compiler**.

---

## 2. Core Principles (Normative)

Every feature in `xmlspec!` must satisfy the following invariants:

1. **Streaming-safe**

   * All decisions are made using only:

     * the current XML event
     * the ancestor stack
     * the parent
     * the attributes of the current element
2. **Single-pass**

   * No buffering of siblings or descendants
3. **Bounded memory**

   * Memory usage grows with specification size, not document size
4. **Compile-time specialization**

   * Genericity exists at compile time, not in the hot path
5. **Predictable performance**

   * O(1) work per XML event (amortized)

Anything that violates these principles is explicitly out of scope.

---

## 3. Conceptual Model

The system operates on four core concepts:

1. **Schemas**
2. **Records**
3. **Selectors**
4. **Reducers**

### High-level flow

```
XML token stream
  → structural matching (from)
      → conditional filtering (where)
          → scope opens
              → reducers activate
                  → optional inline transformations
              → scope closes
          → record emitted
```

---

## 4. Schemas

A schema defines a **closed world** of:

* tag names
* selectors
* record types
* reducers

### Semantics

* One schema expands into one Rust module
* All tags referenced are statically known
* The macro generates:

  * a tag enum
  * a tag interner
  * scope structs
  * reducer implementations
  * selector evaluation code

---

## 5. Records and Scopes

### 5.1 Records

A **record** defines one output value emitted per matched subtree.

Each record corresponds to a **scope** with a clear lifecycle:

* **Open**: on a matching start tag
* **Active**: while inside that element
* **Close**: on the matching end tag
* **Emit**: exactly once, at close

### 5.2 Record Definition

```rust
record SectionData
from tag("section", "appendix")
where ...
{
    ...
}
```

---

## 6. `from`: Structural Root Matching

### Purpose

The `from` clause defines **which element names may start a scope**.

### Rules (Strict)

* `from` may only specify tag names
* No selectors
* No predicates
* No boolean logic

### Syntax

```rust
from tag("section")
from tag("section", "appendix")
```

### Semantics

At runtime:

```rust
if current_tag ∈ from_tags {
    // candidate scope root
}
```

This separation ensures:

* scope lifetime is purely structural
* predictable opening/closing
* minimal hot-path cost

---

## 7. `where`: Conditional Filtering

### Purpose

The `where` clause determines **whether a structurally valid root is allowed to open a scope**.

### Semantics

* Evaluated on the same `Start` event that matched `from`
* Uses the unified selector grammar
* If false → scope is not opened

---

## 8. Fields and Reducers

### 8.1 Fields

Each field defines a **streaming reducer** that runs while the scope is active.

```rust
field_name: reducer() where selector,
```

### Semantics

* Reducers are inactive until their selector matches
* Reducers only see events inside their parent scope
* Reducers accumulate output incrementally

---

## 9. Reducer Types

### Supported reducers

| Reducer           | Description                                |
| ----------------- | ------------------------------------------ |
| `first_text()`    | Capture text of the first matching element |
| `all_text()`      | Capture text of all matching elements      |
| `attr("x")`       | Capture attribute `x`                      |
| `all_fragments()` | Capture inline-typed fragments             |

Reducers are **compile-time generated**, not dynamic objects.

---

## 10. Inline Transformations (Fragments)

### Purpose

Inline transformations allow text to be emitted as **typed fragments**, preserving inline structure.

### Example

```xml
abc <heading>xyz</heading> def
```

→

```rust
[
  Text("abc "),
  Bold("xyz"),
  Text(" def"),
]
```

---

### Syntax

```rust
body: all_fragments()
    where tag("p")
    inline {
        tag("heading") => Bold,
        tag("i")       => Italic,
    },
```

---

### Semantics

* Inline transforms are reducer-local
* Reducer maintains an inline-style stack
* Text is flushed into fragments when styles change
* Nested inline elements are supported
* Text outside any inline style becomes `Text(...)`

### Fragment model (conceptual)

```rust
enum Fragment {
    Text(String),
    Bold(String),
    Italic(String),
}
```

---

## 11. Unified Selector Language

Selectors are **boolean predicates evaluated on the current element**.

They are used in:

* `where` (record filtering)
* field activation
* inline transformation rules

Selectors are evaluated **only on `Start` events**.

---

## 12. Selector Grammar (Authoritative)

### BNF

```
selector       ::= tag_expr
                 | ancestor_expr
                 | parent_expr
                 | attr_expr
                 | and_expr
                 | or_expr
                 | not_expr
                 | "(" selector ")"
```

---

### Tag selector

```
tag_expr       ::= "tag" "(" STRING ("," STRING)* ")"
```

True if the current element name matches any listed tag.

---

### Structural selectors

```
ancestor_expr  ::= "ancestor" "(" selector ")"
parent_expr    ::= "parent" "(" selector ")"
```

#### Restrictions (compile-time enforced)

* `ancestor(...)` may only contain selectors reducible to tag checks:

  ```
  tag("x") | or(tag("x"), tag("y"), ...)
  ```
* Attribute predicates inside `ancestor(...)` are forbidden

---

### Attribute selectors

```
attr_expr      ::= "has_attr" "(" STRING ")"
                 | "attr_is"  "(" STRING "," STRING ")"
```

Evaluated by scanning attributes of the current element.

---

### Boolean combinators (function syntax)

```
and_expr       ::= "and" "(" selector ("," selector)+ ")"
or_expr        ::= "or"  "(" selector ("," selector)+ ")"
not_expr       ::= "not" "(" selector ")"
```

* Short-circuit evaluation
* Empty `and()` / `or()` is invalid

---

## 13. Inline Rule Selectors (Restricted)

Inline rules:

```rust
inline {
    selector => FragmentVariant,
}
```

### Restrictions

* Selector must be reducible to a tag check
* No `ancestor`, `parent`, or attribute predicates
* Enforced at compile time

This keeps inline logic strictly local and streaming-safe.

---

## 14. Compile-Time Validation Rules (Normative)

The macro **must reject**:

1. Any non-tag logic in `from`
2. Attribute predicates inside `ancestor(...)`
3. Empty `and()` / `or()`
4. Inline rules using non-tag selectors
5. Reducers without a `where` clause (unless explicitly allowed)
6. Unknown fragment variants
7. Any construct requiring sibling or descendant buffering

---

## 15. Runtime Semantics Summary

At runtime:

1. XML events are read sequentially
2. Tag names are interned to small enums
3. A stack and depth counters track ancestry
4. `from` performs a cheap structural match
5. `where` selector decides scope opening
6. Active scopes receive events
7. Reducers activate on selector matches
8. Inline reducers emit typed fragments incrementally
9. Scope closes → record emitted

No DOM. No backtracking. No buffering.

---

## 16. Mental Model (Canonical)

> **`from`** — “Which tags may start a record?”
> **`where`** — “Under what conditions is it valid?”
> **Reducers** — “What do I accumulate while inside?”
> **Inline transforms** — “How is text typed as it flows?”

If a feature does not fit this model, it does not belong in `xmlspec!`.

---

## 17. Explicit Non-Goals

This system will **never** support:

* XPath or XQuery
* sibling traversal
* positional predicates
* descendant content tests
* tree rewriting
* user-defined runtime code

Those features violate streaming guarantees.

---

## 18. Intended Use

`xmlspec!` is designed for:

* legal text ingestion
* regulatory corpora
* large structured XML
* data pipelines where **performance and predictability matter**

It trades expressive power for **speed, safety, and clarity**.

---

## 19. Status

This document defines the **final surface language and execution model**.

Future work should:

* add new reducers
* add new *stream-safe* selectors
* improve diagnostics

…but **not** expand the language in ways that compromise streaming invariants.