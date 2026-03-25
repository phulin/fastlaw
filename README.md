<p align="center">
  <img src="./assets/fastlaw-logo.svg" alt="fast.law" width="720" />
</p>

# fast.law
This is the source code for [fast.law], an in-progress repository of legal information and tools. There are two main features right now: automated scraping and congressional redlines. The bulk of the code is written in TypeScript; the scrapers are written in Rust to take advantage of `quick_xml` and otherwise go at native speed.

## Automated Scraping

Most legal text is technically public, but not practically usable. It is scattered across dozens of official sites, published in inconsistent formats, and often impossible to search well without a paid database. The core idea behind `fast.law` is that web scraping is really a translation problem: take fragmented, messy source material and translate it into a clean, searchable legal corpus. Because there are too many documents to give them all to the LLM, the LLM needs to write repeatable code to do the scraping.

This repository’s ingestion system is built around that idea. For each new jurisdiction, the machine writes the scraper from a specification, proves the extraction with tests, and only then ships the parser into the ingest pipeline. The goal is not just to "download pages," but to recover legal structure: titles, chapters, sections, headings, notes, history, cross-references, and per-section text blocks with stable IDs and deterministic ordering.

### How It Works

Each scraper follows the same workflow:

1. Write a source specification: how to access the data, what format it is in, and how hierarchy and section text are encoded.
2. Write tests first, including extraction of structure, section bodies, formatting details, notes/history, and cross-reference links.
3. Implement the scraper inside the containerized ingest runtime.
4. Stream nodes back to the Worker in batches, where they are persisted and versioned.
5. Validate the result with fixture tests, integration tests, and manual spot checks on tricky sections.

The implementation standard is documented in [`SCRAPER_SPECIFICATION.md`](./SCRAPER_SPECIFICATION.md). New scrapers are expected to emit clean hierarchies, preserve source detail, batch inserts instead of writing node-by-node, and keep memory bounded while parsing.

### Why This Matters

Today, the best free way to answer many legal questions is still some combination of "Google it" and "hope the right page ranks first." If you work at a law firm, you probably reach for Westlaw or Lexis. That gap exists even when the underlying law itself is public domain or otherwise publicly available.

Automated scraping is the infrastructure layer that closes that gap. If we can reliably turn official legal sources into structured data, we can make the law easier to search, compare, cite, and reason over without depending on proprietary distribution channels.

### Current Status

What is working now:

- United States Code
- U.S. Public Laws
- Connecticut General Statutes
- Massachusetts General Laws
- New Hampshire Revised Statutes
- Rhode Island General Laws
- Vermont Statutes

The pipeline is repeatable end-to-end, and the scraper architecture is in place. In practice, that means `fast.law` can ingest official legal sources into a normalized internal representation that is usable for search, navigation, and downstream legal tooling.

### Gaps

The current weak point is validation. The system can occasionally report a successful ingest even when no useful content made it into the database. Better self-validation loops, stronger ingest sanity checks, and broader jurisdiction coverage are the main next steps.

## Automated Redlining
Most people never read proposed federal legislation in its raw form, and the format is a big reason why. Even if you are comfortable reading statutes, many bills are not written as clean replacement text. They are written as amendment instructions: strike this phrase, redesignate that paragraph, insert a new clause after some other clause, and so on. To understand what a bill actually does, you have to locate the underlying statute and mentally apply the edits yourself.

That is a bad interface. Congress now has an internal redlining tool for staff, but outside readers usually end up with ad hoc Word documents or PDFs that someone manually marked up. The goal of this project’s redlining work is to turn amendment instructions into a readable diff automatically: fetch the existing U.S. Code section, parse the bill text, apply the edits in order, and render something closer to track changes.

### How It Works

The current prototype lives in [`packages/web`](./packages/web) and is built around a traditional parser pipeline rather than an LLM:

1. Extract paragraphs from the uploaded bill PDF in the browser with `pdf.js`.
2. Detect spans of text that look like amendment instructions.
3. Parse those instructions with a handwritten Backus-Naur Form grammar in [`packages/web/amendment-grammar.bnf`](./packages/web/amendment-grammar.bnf).
4. Translate the parsed syntax tree into a semantic edit tree: what section is being targeted, what scope is being modified, and what concrete edits need to happen.
5. Fetch the current body of the referenced U.S. Code section.
6. Apply the edits against a canonical document model and render the result as a redline.

The key idea is that congressional amendment prose looks intimidating, but it is highly formulaic. Instructions like "by striking", "by inserting", "redesignating", and "adding at the end the following" are awkward English for humans, but they are exactly the kind of repeated structure that a grammar and edit engine can handle well. The parser does not need to "understand the law" in a general sense. It needs to recognize a constrained language for statutory edits and map that language onto deterministic document operations.

### Why Use a Grammar

The redline pipeline is intentionally mostly client-side. That keeps hosting costs low and avoids shipping bill text to a model just to recover structure that is already present in the source. A grammar-based approach also makes failure modes clearer: when a pattern is unsupported, we can see which production failed, extend the grammar, add a test, and rerun the pipeline.

This is not a toy parser. The amendment grammar currently fully parses H.R. 1, an 870-page bill, in roughly 147 lines of BNF. That grammar feeds the rest of the system: instruction discovery, scope resolution, translation into edits, application against the current statute text, and visual rendering of insertions and deletions.

### Limits

The hard part is not getting one instruction to work. The hard part is accumulating enough grammar and edit logic to survive hundreds of slightly different phrasings without the system becoming incoherent. That is the main engineering problem here: building something formal enough to be reliable, but flexible enough to cover real congressional drafting.

AI helped with the surrounding UI and pipeline work, but the grammar itself ended up being mostly manual. In practice, repeated local edits were easier to make by hand than by trying to get a model to keep the grammar clean over dozens of successive fixes.
