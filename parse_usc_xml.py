#!/usr/bin/env python3
"""
Ingest US Code XML from usc_mirror directory.
Outputs JSON per section (R2) and SQL for sources/levels/documents (D1).
"""
import argparse
import json
import os
import re
import xml.etree.ElementTree as ET

USLM_NS = "http://xml.house.gov/schemas/uslm/1.0"


def tag(name):
    return f"{{{USLM_NS}}}{name}"


def text_content(node):
    """Recursive text from element and descendants, stripping refs etc. for plain text."""
    if node is None:
        return ""
    if node.text:
        out = [node.text]
    else:
        out = []
    for child in node:
        # Include ref text (e.g. "July 30, 1947, ch. 388"); skip footnoteRef (marker only) and note (handled elsewhere).
        if child.tag in (tag("footnoteRef"), tag("note")):
            out.append("")  # placeholder so we don't lose tail
        else:
            out.append(text_content(child))
        if child.tail:
            out.append(child.tail)
    return "".join(out).strip()


def normalized_whitespace(s):
    if not s:
        return ""
    return "\n\n".join(
        " ".join(line.split()) for line in s.splitlines() if line.strip()
    ).strip()


def element_itertext(el):
    """All text from element and descendants (no skipping). Use for sourceCredit/refs."""
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def parse_identifier(ident):
    """Parse /us/usc/t1 or /us/usc/t1/ch1 or /us/usc/t1/s1 -> (title, chapter, section)."""
    if not ident or not ident.startswith("/us/usc/"):
        return None, None, None
    rest = ident[len("/us/usc/") :].strip("/")
    parts = rest.split("/")
    title_num = None
    chapter_num = None
    section_num = None
    for part in parts:
        if part.startswith("t"):
            title_num = part[1:]
        elif part.startswith("ch"):
            chapter_num = part[2:]
        elif part.startswith("s"):
            section_num = part[1:]
    return title_num, chapter_num, section_num


def extract_section_body(section_el):
    """Extract main body from section: handles various structural patterns in USC XML."""
    parts = []
    # Tags that contain body content (not metadata like num, heading, sourceCredit, notes)
    body_tags = {
        tag("content"),
        tag("chapeau"),
        tag("subsection"),
        tag("paragraph"),
        tag("subparagraph"),
        tag("clause"),
        tag("p"),
    }
    skip_tags = {tag("num"), tag("heading"), tag("sourceCredit"), tag("notes")}

    def extract_recursive(el):
        """Recursively extract text from body elements."""
        collected = []
        # Get direct text content from content/chapeau/p elements
        if el.tag in (tag("content"), tag("chapeau"), tag("p")):
            txt = text_content(el)
            if txt:
                collected.append(txt)
        else:
            # For structural elements (subsection, paragraph, etc.), recurse into children
            for child in el:
                if child.tag in skip_tags:
                    continue
                if child.tag in body_tags:
                    collected.extend(extract_recursive(child))
        return collected

    # Process direct children of section that are body content
    for node in section_el:
        if node.tag in skip_tags:
            continue
        if node.tag in body_tags:
            parts.extend(extract_recursive(node))

    return normalized_whitespace("\n\n".join(p for p in parts if p))


def extract_source_credit(section_el):
    """Extract sourceCredit as history line (direct child of section). Use itertext so ref/date text is never lost."""
    sc = section_el.find(tag("sourceCredit"))
    if sc is None:
        return ""
    return normalized_whitespace(element_itertext(sc))


def extract_notes(section_el):
    """Extract amendments (history_long) and statutory/editorial notes (citations). Only direct notes child."""
    notes_el = section_el.find(tag("notes"))
    if notes_el is None:
        return "", ""
    amendments = []
    statutory = []
    for note in notes_el.findall(tag("note")):
        topic = note.get("topic") or ""
        role = note.get("role") or ""
        heading_el = note.find(tag("heading"))
        heading = text_content(heading_el) if heading_el is not None else ""
        body_parts = []
        for p in note.findall(f".//{tag('p')}"):
            body_parts.append(text_content(p))
        body = normalized_whitespace("\n\n".join(body_parts))
        if not body and heading:
            body = heading
        if topic == "amendments" or "amendments" in heading:
            amendments.append(body)
        elif "crossHeading" in role or "Editorial" in heading or "Statutory" in heading:
            continue  # skip section headers
        elif topic or body:
            statutory.append((heading, body))
    history_long = "\n\n".join(amendments) if amendments else ""
    citations = "\n\n".join(
        f"{h}\n{b}" if h else b for h, b in statutory if b
    ).strip()
    return history_long, citations


def iter_sections(root_el, doc_title_num):
    """Yield (title_num, chapter_id, chapter_heading, section_el) for each section."""
    main = root_el.find(tag("main"))
    if main is None:
        return
    title_el = main.find(tag("title"))
    if title_el is None:
        return
    title_ident = title_el.get("identifier")
    title_num, _, _ = parse_identifier(title_ident)
    if not title_num:
        title_num = doc_title_num
    current_chapter_id = None
    current_chapter_heading = None
    for elem in title_el.iter():
        if elem.tag == tag("chapter"):
            ch_ident = elem.get("identifier")
            _, ch_num, _ = parse_identifier(ch_ident)
            num_el = elem.find(tag("num"))
            heading_el = elem.find(tag("heading"))
            current_chapter_id = f"{title_num}-{ch_num}" if ch_num else None
            current_chapter_heading = (
                text_content(heading_el) if heading_el is not None else ""
            )
        elif elem.tag == tag("section"):
            ident = elem.get("identifier")
            if ident and ident.startswith("/us/usc/") and "/s" in ident:
                yield title_num, current_chapter_id, current_chapter_heading, elem


def section_slug(title_num, section_num):
    """R2 path (no .json): statutes/usc/section/{title}/{section}."""
    return f"statutes/usc/section/{title_num}/{section_num}"


def level_slug(source_slug, level_type, identifier):
    """Generate slug for a level (title or chapter)."""
    return f"statutes/{source_slug}/{level_type}/{identifier}"


def emit_r2_indexes(output_root, titles, chapters, source_slug="usc"):
    """Write index JSON files for each title and chapter."""
    os.makedirs(output_root, exist_ok=True)
    total = 0

    # Title indexes
    for title_num, title_name in sorted(titles.items(), key=lambda x: title_sort_key(x[0])):
        slug = level_slug(source_slug, "title", title_num)
        title_chapters = [
            {
                "identifier": ch_id.split("-", 1)[1] if "-" in ch_id else ch_id,
                "heading": heading,
            }
            for ch_id, (_, heading) in sorted(
                chapters.items(), key=lambda x: chapter_sort_key(x[0])
            )
            if "-" in ch_id and ch_id.split("-", 1)[0] == title_num
        ]
        content = {
            "version": 1,
            "type": "index",
            "level_type": "title",
            "title_num": title_num,
            "title_name": title_name,
            "chapters": title_chapters,
        }
        path = os.path.join(output_root, f"{slug}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=True, indent=2)
        total += 1

    # Chapter indexes
    for chapter_id, (title_num, chapter_heading) in sorted(
        chapters.items(), key=lambda x: chapter_sort_key(x[0])
    ):
        if "-" not in chapter_id:
            continue
        chapter_num = chapter_id.split("-", 1)[1]
        slug = level_slug(source_slug, "chapter", f"{title_num}/{chapter_num}")
        content = {
            "version": 1,
            "type": "index",
            "level_type": "chapter",
            "title_num": title_num,
            "chapter_id": chapter_id,
            "chapter_num": chapter_num,
            "chapter_name": chapter_heading,
        }
        path = os.path.join(output_root, f"{slug}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=True, indent=2)
        total += 1

    print(f"Wrote {total} level index files to R2")
    return total


def section_sort_key(section_num):
    """Sort key for section numbers (1, 2, 10, 101, 7a)."""
    m = re.match(r"^(\d+)([a-z]*)$", str(section_num).lower())
    if not m:
        return (0, str(section_num).lower())
    return (1, (int(m.group(1)), m.group(2)))


def title_sort_key(t):
    """Sort key for title numbers (1, 2, 28, 28a, 50A)."""
    return section_sort_key(t)


def chapter_sort_key(chapter_id):
    """Sort key for chapter_id 'title-chapter' (e.g. 1-1, 28-5)."""
    parts = str(chapter_id).split("-", 1)
    if len(parts) != 2:
        return (0, chapter_id)
    return (title_sort_key(parts[0]), section_sort_key(parts[1]))


def emit_json(output_root, sections_by_slug, doc_id_by_slug):
    """Write one JSON file per section."""
    os.makedirs(output_root, exist_ok=True)
    total = 0
    for slug, data in sections_by_slug.items():
        doc_id = doc_id_by_slug[slug]
        blocks = []
        if data.get("body"):
            blocks.append({"type": "body", "content": data["body"]})
        if data.get("history_short"):
            blocks.append(
                {
                    "type": "history_short",
                    "label": "History",
                    "content": data["history_short"],
                }
            )
        if data.get("history_long"):
            blocks.append(
                {
                    "type": "history_long",
                    "label": "History Notes",
                    "content": data["history_long"],
                }
            )
        if data.get("citations"):
            blocks.append(
                {
                    "type": "citations",
                    "label": "Notes",
                    "content": data["citations"],
                }
            )
        content = {
            "version": 2,
            "doc_id": doc_id,
            "doc_type": "statute",
            "blocks": blocks,
        }
        path = os.path.join(output_root, f"{slug}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=True, indent=2)
        total += 1
        if total % 1000 == 0:
            print(f"Wrote {total} section JSON files...")
    return total


def escape_sql(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def emit_sql(output_path, titles, chapters, sections):
    """Write D1 import SQL: sources, levels (title/chapter/section), documents."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    lines = []

    lines.append("-- USC: sources")
    lines.append(
        "INSERT INTO sources (id, name, jurisdiction, region, doc_type, edition, "
        "citation_prefix, slug, sort_order) VALUES ('usc', "
        "'United States Code', 'federal', 'US', 'statute', NULL, "
        "'U.S.C.', 'usc', 1);"
    )

    lines.append("\n-- Levels (Titles)")
    for idx, (title_num, title_name) in enumerate(
        sorted(titles.items(), key=lambda x: title_sort_key(x[0]))
    ):
        tid = f"lvl_usc_title_{title_num}"
        slug = level_slug("usc", "title", title_num)
        lines.append(
            f"INSERT INTO levels (id, source_id, doc_type, level_index, level_name, "
            f"label, identifier, identifier_sort, name, parent_id, doc_id, sort_order, slug) "
            f"VALUES ({escape_sql(tid)}, 'usc', 'statute', 0, 'title', "
            f"{escape_sql(title_num)}, {escape_sql(title_num)}, {escape_sql(title_num)}, "
            f"{escape_sql(title_name)}, NULL, NULL, {idx}, {escape_sql(slug)});"
        )

    lines.append("\n-- Levels (Chapters)")
    for idx, (chapter_id, (title_num, chapter_heading)) in enumerate(
        sorted(chapters.items(), key=lambda x: chapter_sort_key(x[0]))
    ):
        parent_id = f"lvl_usc_title_{title_num}"
        chapter_num = chapter_id.split("-", 1)[1] if "-" in chapter_id else chapter_id
        slug = level_slug("usc", "chapter", f"{title_num}/{chapter_num}")
        lines.append(
            f"INSERT INTO levels (id, source_id, doc_type, level_index, level_name, "
            f"label, identifier, identifier_sort, name, parent_id, doc_id, sort_order, slug) "
            f"VALUES ({escape_sql('lvl_usc_chapter_' + chapter_id)}, 'usc', 'statute', 1, "
            f"'chapter', {escape_sql(chapter_id)}, {escape_sql(chapter_id)}, "
            f"{escape_sql(chapter_id)}, {escape_sql(chapter_heading)}, "
            f"{escape_sql(parent_id)}, NULL, {idx}, {escape_sql(slug)});"
        )

    lines.append("\n-- Documents and Levels (Sections)")
    for idx, row in enumerate(
        sorted(
            sections,
            key=lambda r: (
                title_sort_key(r["title_num"]),
                section_sort_key(r["section_num"]),
            ),
        )
    ):
        slug = row["slug"]
        doc_id = row["doc_id"]
        level_id = row["level_id"]
        parent_id = row["parent_level_id"]
        lines.append(
            f"INSERT INTO documents (id, source_id, doc_type, title, citation, slug, as_of, "
            f"effective_start, effective_end, source_url, created_at, updated_at) "
            f"VALUES ({escape_sql(doc_id)}, 'usc', 'statute', {escape_sql(row['heading'])}, "
            f"{escape_sql(row['section_num'])}, {escape_sql(slug)}, NULL, NULL, NULL, NULL, NULL, NULL);"
        )
        lines.append(
            f"INSERT INTO levels (id, source_id, doc_type, level_index, level_name, label, "
            f"identifier, identifier_sort, name, parent_id, doc_id, sort_order) "
            f"VALUES ({escape_sql(level_id)}, 'usc', 'statute', 2, 'section', "
            f"{escape_sql(row['section_num'])}, {escape_sql(row['section_num'])}, "
            f"{escape_sql(row['section_num'])}, {escape_sql(row['heading'])}, "
            f"{escape_sql(parent_id)}, {escape_sql(doc_id)}, {idx});"
        )

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"Wrote D1 import SQL to {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Parse USC XML mirror into JSON (R2) and SQL (D1)."
    )
    parser.add_argument(
        "--mirror",
        default="usc_mirror",
        help="Directory containing usc01.xml, usc02.xml, ...",
    )
    parser.add_argument(
        "--import-sql",
        default="data/d1/usc_import.sql",
        help="D1 import SQL output path.",
    )
    parser.add_argument(
        "--r2-root",
        default="data/r2",
        help="R2 content output root (JSON files under statutes/usc/section/...).",
    )
    args = parser.parse_args()

    sections_by_slug = {}
    doc_id_by_slug = {}
    titles = {}
    chapters = {}
    section_rows = []
    seen_slugs = set()

    xml_files = sorted(
        [
            os.path.join(args.mirror, f)
            for f in os.listdir(args.mirror)
            if f.endswith(".xml") and f.startswith("usc")
        ]
    )

    num_files = len(xml_files)
    for file_idx, xml_path in enumerate(xml_files, 1):
        base = os.path.basename(xml_path)
        file_title = re.sub(r"^usc|\.xml$", "", base, flags=re.IGNORECASE)
        if not file_title:
            continue
        print(f"Processing {base} ({file_idx}/{num_files})...", flush=True)
        try:
            tree = ET.parse(xml_path)
        except ET.ParseError as e:
            print(f"Parse error {xml_path}: {e}")
            continue
        root = tree.getroot()
        doc_title_num = file_title
        if root.get("identifier"):
            t, _, _ = parse_identifier(root.get("identifier"))
            if t:
                doc_title_num = t
        file_sections = 0
        for title_num, chapter_id, chapter_heading, section_el in iter_sections(
            root, doc_title_num
        ):
            ident = section_el.get("identifier")
            _, _, section_num = parse_identifier(ident)
            if not section_num:
                num_el = section_el.find(tag("num"))
                section_num = num_el.get("value", "") if num_el is not None else ""
            if not section_num:
                continue
            heading_el = section_el.find(tag("heading"))
            heading = (
                normalized_whitespace(text_content(heading_el))
                if heading_el is not None
                else ""
            )
            body = extract_section_body(section_el)
            history_short = extract_source_credit(section_el)
            history_long, citations = extract_notes(section_el)

            slug = section_slug(title_num, section_num)
            doc_id = f"doc_usc_{title_num}-{section_num}"
            level_id = f"lvl_usc_section_{title_num}-{section_num}"
            parent_level_id = (
                f"lvl_usc_chapter_{chapter_id}" if chapter_id else f"lvl_usc_title_{title_num}"
            )

            titles[title_num] = titles.get(title_num) or f"Title {title_num}"
            if chapter_id:
                chapters[chapter_id] = (title_num, chapter_heading or chapter_id)

            sections_by_slug[slug] = {
                "body": body,
                "history_short": history_short,
                "history_long": history_long,
                "citations": citations,
            }
            doc_id_by_slug[slug] = doc_id
            if slug not in seen_slugs:
                seen_slugs.add(slug)
                section_rows.append(
                    {
                        "title_num": title_num,
                        "chapter_id": chapter_id,
                        "section_num": section_num,
                        "heading": heading,
                        "slug": slug,
                        "doc_id": doc_id,
                        "level_id": level_id,
                        "parent_level_id": parent_level_id,
                    }
                )
            file_sections += 1
        print(f"  -> {file_sections} sections", flush=True)

    # Fill title names from meta/dc:title (dc namespace)
    DC_NS = "http://purl.org/dc/elements/1.1/"
    for xml_path in xml_files:
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            doc_title_num, _, _ = parse_identifier(root.get("identifier") or "")
            if not doc_title_num:
                base = os.path.basename(xml_path)
                doc_title_num = re.sub(r"^usc|\.xml$", "", base, flags=re.IGNORECASE)
            if not doc_title_num:
                continue
            meta = root.find(f".//{tag('meta')}")
            if meta is not None:
                for child in meta:
                    if child.tag == f"{{{DC_NS}}}title" and child.text:
                        titles[doc_title_num] = child.text.strip()
                        break
        except Exception:
            pass

    total_json = emit_json(args.r2_root, sections_by_slug, doc_id_by_slug)
    total_indexes = emit_r2_indexes(args.r2_root, titles, chapters, source_slug="usc")
    emit_sql(args.import_sql, titles, chapters, section_rows)
    print(f"Wrote {total_json} section JSON files; {total_indexes} level index files; {len(section_rows)} sections in SQL.")


if __name__ == "__main__":
    main()
