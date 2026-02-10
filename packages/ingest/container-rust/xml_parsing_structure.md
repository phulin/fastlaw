Yep — that’s the cleanest version. Once you say it out loud, the extra distinction really is unnecessary.

Below is the **final, simplified design doc**, with **one enum**, **one stack**, **one mask**, and nothing else. This is the version I’d actually recommend implementing.

---

# Design Doc

## Minimal streaming XML state machine with enum-indexed bitmask ancestry (Rust + quick-xml)

---

## 1. Problem statement

We want to ingest large XML documents in a **single streaming pass**, extracting structured data based on:

* where we are in the XML tree
* which ancestors we are inside or not inside
* attributes and text of selected elements

Constraints:

* bounded memory
* near-optimal performance
* no DOM, no XPath, no DSL
* explicit, auditable control flow
* ability to express predicates like
  **inside `<section>` but not inside `<note>`**

We assume:

* a known or semi-known schema
* a fixed set of XML tags we care about semantically

---

## 2. Core idea

Maintain **two parallel stacks** while streaming:

1. `tag_stack: Vec<Tag>`
   → exact ancestry, but only for tags we care about

2. `mask_stack: Vec<u64>`
   → semantic ancestry encoded as a bitmask

Each tag corresponds to **exactly one bit**, determined by its enum discriminant.

There is **no distinction** between “tag” and “care tag”.

---

## 3. Tag enum (single source of truth)

```rust
#[repr(u8)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum Tag {
    Title       = 0,
    Chapter     = 1,
    Section     = 2,
    Subsection  = 3,
    Paragraph   = 4,
    Heading     = 5,
    Note        = 6,
    Num         = 7,
    // …
}
```

### Properties

* Discriminant == bit position
* Max 64 variants with `u64`
* Enum defines **everything the parser cares about**
* If a tag isn’t in this enum, it doesn’t exist to the state machine

---

## 4. Bit definition (mechanical)

```rust
#[inline(always)]
fn bit(tag: Tag) -> u64 {
    1u64 << (tag as u64)
}
```

No tables.
No maps.
No conditionals.

---

## 5. Mapping XML element names → Tag

During parsing, element names are interned to an `Option<Tag>`:

```rust
fn classify(name: &[u8]) -> Option<Tag> {
    match name {
        b"title"       => Some(Tag::Title),
        b"chapter"     => Some(Tag::Chapter),
        b"section"     => Some(Tag::Section),
        b"subsection"  => Some(Tag::Subsection),
        b"p"           => Some(Tag::Paragraph),
        b"heading"     => Some(Tag::Heading),
        b"note"        => Some(Tag::Note),
        b"num"         => Some(Tag::Num),
        _ => None,
    }
}
```

**Important invariant**
If `classify` returns `None`, the tag is completely ignored by the state machine.

---

## 6. Stack invariants

At all times:

```rust
tag_stack.len() == mask_stack.len()
```

And for depth `i`:

```rust
mask_stack[i] =
    OR of bits for all tags in tag_stack[0..=i]
```

---

## 7. Push / pop logic

### On `Start`

```rust
let parent_mask = mask_stack.last().copied().unwrap_or(0);

if let Some(tag) = classify(e.name().as_ref()) {
    tag_stack.push(tag);
    mask_stack.push(parent_mask | bit(tag));
}
```

### On `End`

```rust
if classify(e.name().as_ref()).is_some() {
    tag_stack.pop();
    mask_stack.pop();
}
```

Ignored tags do not affect stacks at all.

---

## 8. Expressing ancestor predicates

At any point:

```rust
let mask = *mask_stack.last().unwrap_or(&0);
```

### Examples

```rust
// inside <section>
mask & bit(Tag::Section) != 0

// inside <section> but not <note>
mask & bit(Tag::Section) != 0 &&
mask & bit(Tag::Note) == 0

// inside subsection only (not heading or note)
mask & (
    bit(Tag::Subsection)
  | bit(Tag::Heading)
  | bit(Tag::Note)
) == bit(Tag::Subsection)

// inside title → chapter → section
mask & (
    bit(Tag::Title)
  | bit(Tag::Chapter)
  | bit(Tag::Section)
) ==
  bit(Tag::Title)
| bit(Tag::Chapter)
| bit(Tag::Section)
```

All predicates are constant-time integer ops.

---

## 9. Streaming loop (entire control flow)

```rust
loop {
    match reader.read_event_into(&mut buf)? {
        Event::Start(e) => {
            let parent_mask = mask_stack.last().copied().unwrap_or(0);

            if let Some(tag) = classify(e.name().as_ref()) {
                tag_stack.push(tag);
                mask_stack.push(parent_mask | bit(tag));
            }

            on_start(&tag_stack, &mask_stack, &e);
        }

        Event::Text(t) => {
            on_text(&tag_stack, &mask_stack, t.as_ref());
        }

        Event::End(e) => {
            on_end(&tag_stack, &mask_stack);

            if classify(e.name().as_ref()).is_some() {
                tag_stack.pop();
                mask_stack.pop();
            }
        }

        Event::Eof => break,
        _ => {}
    }
}
```

This is the *entire* engine.

---

## 10. Scoped state machines (the clean pattern)

Each extraction target has its **own tiny state**, activated and completed based on:

* current tag
* current mask
* current depth (`tag_stack.len()`)

### Example: capture subsection text outside notes

```rust
struct SubsectionState {
    depth: usize,
    text: String,
}

let mut subsections: Vec<SubsectionState> = Vec::new();
```

### Activation

```rust
fn on_start(tags: &[Tag], masks: &[u64], _e: &BytesStart) {
    let mask = *masks.last().unwrap_or(&0);

    if tags.last() == Some(&Tag::Subsection)
        && mask & bit(Tag::Note) == 0
    {
        subsections.push(SubsectionState {
            depth: tags.len(),
            text: String::new(),
        });
    }
}
```

### Text capture

```rust
fn on_text(tags: &[Tag], _masks: &[u64], txt: &[u8]) {
    if let Some(s) = subsections.last_mut() {
        if tags.len() == s.depth {
            s.text.push_str(std::str::from_utf8(txt).unwrap());
        }
    }
}
```

### Completion

```rust
fn on_end(tags: &[Tag], _masks: &[u64]) {
    if let Some(s) = subsections.last() {
        if tags.len() == s.depth {
            emit_subsection(subsections.pop().unwrap());
        }
    }
}
```

No global state enum.
No transitions.
No ambiguity.

---

## 11. Ancestry capture

Because `tag_stack` exists, ancestry is trivial:

* **Compact**: `Vec<Tag>`
* **String** (emit-time only):

```rust
tags.iter()
    .map(|t| format!("{:?}", t))
    .collect::<Vec<_>>()
    .join("/")
```

Or resolve to canonical XML names if needed.

---

## 12. Performance characteristics

Hot-path operations per event:

* optional enum match
* stack push/pop
* single OR
* a few ANDs
* zero allocations

This is effectively optimal for streaming XML.