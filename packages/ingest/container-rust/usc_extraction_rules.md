# USC XML Extraction Rules

This document outlines the extraction logic for the United States Code (USC) XML parser. The parser identifies two main types of entities: **Structural Levels** (hierarchy) and **Sections** (content).

## 1. Document Metadata
**Title Name Strategy:**
1.  Primary: Text content of `//main/title/heading`.
2.  Fallback: If the above is empty, uses `//meta/title`.

---

## 2. Structural Levels
These nodes represent the organizational hierarchy of the code (e.g., Titles, Chapters, Parts).

**Top Node Selector:**
```xpath
//*[self::title or self::subtitle or self::part or self::subpart or self::chapter or self::subchapter or self::division or self::subdivision]
```

**Data Elements:**

| Field | Relative Path / Source | Description |
|-------|------------------------|-------------|
| `level_type` | `local-name()` | The tag name of the element (e.g., "chapter", "part"). |
| `identifier` | `@identifier` | The unique ID for the level. If missing, constructed from the parent ID + prefix + level number. |
| `num` | `./num` | The number designator (e.g., "CHAPTER 1"). Extracted from the text content. |
| `heading` | `./heading` | The title text of the level. **Clean-up Rule**: If the heading ends with `]`, the trailing bracket is removed (common in repealed levels). |
| `parent_identifier` | *(Context)* | The `identifier` of the nearest ancestor in the level hierarchy. |

---

## 3. Sections
These nodes represent the actual statutes/sections of the code.

**Top Node Selector:**
```xpath
//section[not(ancestor::note) and not(ancestor::quotedContent)]
```

**Data Elements:**

| Field | Relative Path / Source | Description |
|-------|------------------------|-------------|
| `section_num` | `@identifier` or `./num/@value` | The section number (e.g., "101"). Extracted from the end of the identifier or the `value` attribute of the num tag. |
| `heading` | `./heading` | The title of the section. **Clean-up Rule**: If the section is bracketed `[...]`, the trailing `]` is removed from the heading string. |
| `body` | `descendant::text()[...]` | Concatenation of text from `content`, `subsection`, `paragraph`, etc. <br> **Formatting Rules:** <br> - Metadata tags (`sourceCredit`, `note`, `heading` of the section itself) are excluded. <br> - `num` and `heading` tags inside the body are wrapped in `**`. <br> - Nested items (like `paragraph` inside `subsection`) are preceded by newlines. |
| `source_credit` | `./sourceCredit` | The concise legislative history credit usually found at the end of a section. |
| `amendments` | `./note` | Detailed amendment notes. **Filter**: Must have `topic="amendments"` OR contain "amendments" in the heading (case-insensitive). |
| `note` | `./note` | Extracted from `note` tags that are **not** amendments. |