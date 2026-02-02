#!/usr/bin/env python3
import argparse
import html
import html.parser
import json
import os
import re
import sqlite3


SECTION_START_RE = re.compile(
    r'<span[^>]*class="catchln"[^>]*id="([^"]+)"[^>]*>',
    re.IGNORECASE,
)
SECTION_LABEL_RE = re.compile(r"^(Secs?)\.\s+([^\.]+)\.\s*(.*)$")
SECTION_RANGE_RE = re.compile(r"^(.+?)\s+to\s+([^,]+)", re.IGNORECASE)


class SectionTextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = {
            "body": [],
            "history_short": [],
            "history_long": [],
            "citations": [],
            "see_also": [],
        }
        self.current_target = "body"
        self.target_stack = []
        self.in_script = False
        self.in_style = False
        self.in_label = False
        self.ignore_depth = 0
        self.in_row = False
        self.row_cells = 0
        self.stop_parsing = False
        self.block_tags = {
            "p",
            "div",
            "table",
            "tr",
            "ul",
            "ol",
            "li",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
        }

    def handle_starttag(self, tag, attrs):
        if self.stop_parsing:
            return
        if self.ignore_depth > 0:
            self.ignore_depth += 1
            return

        if tag == "script":
            self.in_script = True
            return
        if tag == "style":
            self.in_style = True
            return

        if tag == "span":
            for key, value in attrs:
                if key == "class" and value:
                    classes = {c.strip() for c in value.split()}
                    if "catchln" in classes:
                        self.in_label = True
                        return

        if tag == "table":
            for key, value in attrs:
                if key == "class" and value:
                    classes = {c.strip() for c in value.split()}
                    if "nav_tbl" in classes:
                        self.ignore_depth = 1
                        self.stop_parsing = True
                        return

        if tag == "br" or tag == "hr":
            self._newline(self.current_target)
            return

        new_target = self._classify_target(attrs)
        if new_target and new_target != self.current_target:
            self.target_stack.append((tag, self.current_target))
            self.current_target = new_target

        if tag == "tr":
            self.in_row = True
            self.row_cells = 0

        if tag in ("td", "th") and self.in_row:
            if self.row_cells > 0:
                self.parts[self.current_target].append(" | ")
            self.row_cells += 1

        if tag in self.block_tags:
            self._newline(self.current_target)

    def handle_endtag(self, tag):
        if self.stop_parsing:
            return
        if self.ignore_depth > 0:
            self.ignore_depth -= 1
            return

        if tag == "script":
            self.in_script = False
            return
        if tag == "style":
            self.in_style = False
            return

        if tag == "span" and self.in_label:
            self.in_label = False
            return

        if tag == "tr":
            self.in_row = False
            self._newline(self.current_target)
            return

        if self.target_stack and self.target_stack[-1][0] == tag:
            _, prev_target = self.target_stack.pop()
            self.current_target = prev_target

        if tag in self.block_tags:
            self._newline(self.current_target)

    def handle_data(self, data):
        if self.stop_parsing:
            return
        if self.in_script or self.in_style or self.ignore_depth > 0 or self.in_label:
            return
        self.parts[self.current_target].append(data)

    def _newline(self, target):
        if not self.parts[target]:
            self.parts[target].append("\n")
            return
        if not self.parts[target][-1].endswith("\n"):
            self.parts[target].append("\n")

    def get_text(self, target):
        raw = "".join(self.parts[target])
        lines = []
        for line in raw.splitlines():
            cleaned = " ".join(line.split())
            lines.append(cleaned)

        normalized = []
        blank = False
        for line in lines:
            if line == "":
                if not blank:
                    normalized.append("")
                blank = True
            else:
                normalized.append(line)
                blank = False

        return "\n".join(normalized).strip()

    @staticmethod
    def _classify_target(attrs):
        for key, value in attrs:
            if key != "class" or not value:
                continue
            classes = {c.strip() for c in value.split()}
            if {"source", "source-first"} & classes:
                return "history_short"
            if {"history", "history-first"} & classes:
                return "history_long"
            if {"annotation", "annotation-first"} & classes:
                return "citations"
            if {"cross-ref", "cross-ref-first"} & classes:
                return "see_also"
        return None


def extract_label(section_html, section_id):
    pattern = re.compile(
        r'<span[^>]*class="catchln"[^>]*id="{}"[^>]*>(.*?)</span>'.format(
            re.escape(section_id)
        ),
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(section_html)
    if not match:
        return None
    label_html = match.group(1)
    label = re.sub(r"<[^>]+>", "", label_html)
    return html.unescape(label).strip()


def parse_label(label):
    if not label:
        return None, None, None, None
    match = SECTION_LABEL_RE.match(label)
    if not match:
        return None, None, None, None
    number = match.group(2).strip()
    title = match.group(3).strip() or None
    range_start = None
    range_end = None
    if match.group(1).lower().startswith("secs"):
        range_match = SECTION_RANGE_RE.match(number)
        if range_match:
            range_start = range_match.group(1).strip()
            range_end = range_match.group(2).strip()
    else:
        range_start = number
        range_end = number
    return number, title, range_start, range_end


def extract_title_id(section_id, section_number, range_start):
    candidate = range_start or section_number
    if not candidate:
        return None
    if "-" not in candidate:
        cleaned_id = section_id.replace("secs_", "").replace("sec_", "")
        if "-" in cleaned_id:
            return cleaned_id.split("-", 1)[0].strip()
        return candidate.strip()
    return candidate.split("-", 1)[0].strip()


def extract_text_blocks(section_html):
    parser = SectionTextExtractor()
    parser.feed(section_html)
    return {
        "body": parser.get_text("body"),
        "history_short": parser.get_text("history_short"),
        "history_long": parser.get_text("history_long"),
        "citations": parser.get_text("citations"),
        "see_also": parser.get_text("see_also"),
    }


def extract_chapter_title(html_text):
    title_match = re.search(r"<title>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
    if title_match:
        title = re.sub(r"<[^>]+>", "", title_match.group(1))
        title = html.unescape(title).strip()
        if title:
            return title
    meta_match = re.search(
        r'<meta[^>]+name="Description"[^>]+content="([^"]+)"',
        html_text,
        re.IGNORECASE,
    )
    if meta_match:
        return html.unescape(meta_match.group(1)).strip()
    return None


def trim_trailing_headings(body_text):
    if not body_text:
        return body_text
    lines = body_text.splitlines()
    while lines and lines[-1] == "":
        lines.pop()
    heading_re = re.compile(
        r"^(?:PART|SUBPART|ARTICLE|CHAPTER)\s+[IVXLC\d]+$"
    )
    caps_re = re.compile(r"^[A-Z][A-Z\s\-,&]+$")
    paren_heading_re = re.compile(r"^\(([A-Z]|[IVXLC]+)\)$")
    while lines:
        line = lines[-1].strip()
        if heading_re.match(line):
            lines.pop()
            while lines and lines[-1] == "":
                lines.pop()
            continue
        if caps_re.match(line) and len(line) <= 80:
            lines.pop()
            while lines and lines[-1] == "":
                lines.pop()
            continue
        if paren_heading_re.match(line):
            lines.pop()
            while lines and lines[-1] == "":
                lines.pop()
            continue
        break
    return "\n".join(lines).strip()


def extract_sections_from_html(html_text):
    matches = list(SECTION_START_RE.finditer(html_text))
    sections = []
    for index, match in enumerate(matches):
        section_id = match.group(1)
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(html_text)
        section_html = html_text[start:end]
        label = extract_label(section_html, section_id) or section_id
        number, title, range_start, range_end = parse_label(label)
        text_blocks = extract_text_blocks(section_html)
        body = trim_trailing_headings(text_blocks["body"])
        title_id = extract_title_id(section_id, number, range_start)
        sections.append(
            {
                "section_id": section_id,
                "title_id": title_id,
                "section_number": number,
                "section_title": title,
                "section_label": label,
                "section_range_start": range_start,
                "section_range_end": range_end,
                "body": body,
                "history_short": text_blocks["history_short"],
                "history_long": text_blocks["history_long"],
                "citations": text_blocks["citations"],
                "see_also": text_blocks["see_also"],
            }
        )
    return sections


def init_db(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sections (
            section_id TEXT PRIMARY KEY,
            chapter_id TEXT NOT NULL,
            title_id TEXT,
            section_number TEXT,
            section_title TEXT,
            section_label TEXT NOT NULL,
            section_range_start TEXT,
            section_range_end TEXT,
            body TEXT NOT NULL,
            history_short TEXT,
            history_long TEXT,
            citations TEXT,
            see_also TEXT,
            prev_section_id TEXT,
            next_section_id TEXT,
            prev_section_label TEXT,
            next_section_label TEXT,
            source_file TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chapters (
            chapter_id TEXT PRIMARY KEY,
            chapter_title TEXT NOT NULL,
            title_id TEXT,
            title_id_padded TEXT,
            title_id_display TEXT,
            chapter_id_padded TEXT,
            chapter_id_display TEXT,
            section_count INTEGER,
            section_start TEXT,
            section_end TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS titles (
            title_id TEXT PRIMARY KEY,
            title_id_padded TEXT,
            title_id_display TEXT,
            title_name TEXT
        )
        """
    )
    _ensure_column(conn, "sections", "title_id", "TEXT")
    _ensure_column(conn, "sections", "chapter_id", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "sections", "section_range_start", "TEXT")
    _ensure_column(conn, "sections", "section_range_end", "TEXT")
    _ensure_column(conn, "sections", "history_short", "TEXT")
    _ensure_column(conn, "sections", "history_long", "TEXT")
    _ensure_column(conn, "sections", "citations", "TEXT")
    _ensure_column(conn, "sections", "see_also", "TEXT")
    _ensure_column(conn, "sections", "prev_section_id", "TEXT")
    _ensure_column(conn, "sections", "next_section_id", "TEXT")
    _ensure_column(conn, "sections", "prev_section_label", "TEXT")
    _ensure_column(conn, "sections", "next_section_label", "TEXT")
    _ensure_column(conn, "chapters", "title_id", "TEXT")
    _ensure_column(conn, "chapters", "title_id_padded", "TEXT")
    _ensure_column(conn, "chapters", "title_id_display", "TEXT")
    _ensure_column(conn, "chapters", "chapter_id_padded", "TEXT")
    _ensure_column(conn, "chapters", "chapter_id_display", "TEXT")
    _ensure_column(conn, "chapters", "section_count", "INTEGER")
    _ensure_column(conn, "chapters", "section_start", "TEXT")
    _ensure_column(conn, "chapters", "section_end", "TEXT")
    _ensure_column(conn, "titles", "title_id_padded", "TEXT")
    _ensure_column(conn, "titles", "title_id_display", "TEXT")
    _ensure_column(conn, "titles", "title_name", "TEXT")


def _ensure_column(conn, table, column, column_type):
    cursor = conn.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cursor.fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def ingest_sections(conn, sections, source_file, chapter_id):
    rows = [
        (
            section["section_id"],
            chapter_id,
            section["title_id"],
            section["section_number"],
            section["section_title"],
            section["section_label"],
            section["section_range_start"],
            section["section_range_end"],
            section["body"],
            section["history_short"],
            section["history_long"],
            section["citations"],
            section["see_also"],
            None,
            None,
            None,
            None,
            source_file,
        )
        for section in sections
    ]
    conn.executemany(
        """
        INSERT OR REPLACE INTO sections
            (section_id, chapter_id, title_id, section_number, section_title, section_label,
             section_range_start, section_range_end, body, history_short, history_long,
             citations, see_also, prev_section_id, next_section_id, prev_section_label,
             next_section_label, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def ingest_chapter(conn, chapter_id, chapter_title):
    if not chapter_title:
        return
    conn.execute(
        """
        INSERT OR REPLACE INTO chapters (chapter_id, chapter_title)
        VALUES (?, ?)
        """,
        (chapter_id, chapter_title),
    )


def normalize_designator(value):
    if not value:
        return value
    match = re.match(r"^0*([0-9]+)([a-z]*)$", value, re.IGNORECASE)
    if not match:
        return value.lower()
    number = str(int(match.group(1)))
    suffix = match.group(2).lower()
    return f"{number}{suffix}"


def format_designator_display(value):
    if not value:
        return value
    match = re.match(r"^0*([0-9]+)([a-z]*)$", value, re.IGNORECASE)
    if not match:
        return value.upper()
    number = str(int(match.group(1)))
    suffix = match.group(2).upper()
    return f"{number}{suffix}"


def format_designator_padded(value, width=4):
    if not value:
        return value
    match = re.match(r"^0*([0-9]+)([a-z]*)$", value, re.IGNORECASE)
    if not match:
        return value.lower()
    number = match.group(1).zfill(width)
    suffix = match.group(2).lower()
    return f"{number}{suffix}"


def extract_title_name(html_text):
    title_match = re.search(r"<title>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
    if not title_match:
        return None
    title_text = re.sub(r"<[^>]+>", "", title_match.group(1))
    title_text = html.unescape(title_text).strip()
    match = re.match(r"^Title\s+[\w]+?\s*-\s*(.+)$", title_text, re.IGNORECASE)
    if not match:
        return None
    return match.group(1).strip() or None


def ingest_titles(conn, root):
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if not name.lower().startswith("title_") or not name.lower().endswith(".htm"):
                continue
            raw_id = name[len("title_") : -len(".htm")]
            title_id = normalize_designator(raw_id)
            path = os.path.join(dirpath, name)
            with open(path, "rb") as f:
                html_text = f.read().decode("utf-8", errors="ignore")
            title_name = extract_title_name(html_text)
            if not title_id:
                continue
            title_display = format_designator_display(title_id)
            title_padded = format_designator_padded(title_id)
            conn.execute(
                """
                INSERT OR REPLACE INTO titles
                    (title_id, title_id_padded, title_id_display, title_name)
                VALUES (?, ?, ?, ?)
                """,
                (title_id, title_padded, title_display, title_name),
            )


def _natural_key(value):
    parts = re.split(r"(\\d+)", value)
    key = []
    for part in parts:
        if part.isdigit():
            key.append((0, int(part)))
        else:
            key.append((1, part.lower()))
    return key


def _padded_key(value, width=6):
    if not value:
        return ""
    def pad(match):
        return match.group(0).zfill(width)
    return re.sub(r"\d+", pad, value.lower())


def update_prev_next(conn):
    cursor = conn.execute(
        """
        SELECT section_id, section_number, section_range_start, chapter_id, title_id
        FROM sections
        WHERE section_number IS NOT NULL
        """
    )
    rows = cursor.fetchall()
    by_title = {}
    by_chapter = {}
    for section_id, section_number, range_start, chapter_id, title_id in rows:
        raw_id = section_id.replace("secs_", "").replace("sec_", "")
        sort_value = range_start or section_number or raw_id
        sort_key = _padded_key(sort_value if "-" in sort_value else raw_id)
        if title_id:
            by_title.setdefault(title_id, []).append(
                (section_id, sort_key, chapter_id)
            )
        by_chapter.setdefault(chapter_id, []).append((section_id, sort_key, title_id))

    prev_title = {}
    next_title = {}
    for title_id, items in by_title.items():
        items.sort(key=lambda item: item[1])
        for index, (section_id, _, _) in enumerate(items):
            if index > 0:
                prev_title[section_id] = items[index - 1][0]
            if index + 1 < len(items):
                next_title[section_id] = items[index + 1][0]

    prev_chapter = {}
    next_chapter = {}
    for chapter_id, items in by_chapter.items():
        items.sort(key=lambda item: item[1])
        for index, (section_id, _, _) in enumerate(items):
            if index > 0:
                prev_chapter[section_id] = items[index - 1][0]
            if index + 1 < len(items):
                next_chapter[section_id] = items[index + 1][0]

    label_map = {
        section_id: label
        for section_id, label in conn.execute(
            "SELECT section_id, section_label FROM sections"
        ).fetchall()
    }
    updates = []
    for section_id, _, _, _, _ in rows:
        prev_candidate = prev_chapter.get(section_id)
        next_candidate = next_chapter.get(section_id)
        if prev_candidate and prev_title.get(section_id) != prev_candidate:
            prev_candidate = None
        if next_candidate and next_title.get(section_id) != next_candidate:
            next_candidate = None
        prev_label = label_map.get(prev_candidate) if prev_candidate else None
        next_label = label_map.get(next_candidate) if next_candidate else None
        updates.append((prev_candidate, next_candidate, prev_label, next_label, section_id))

    conn.executemany(
        """
        UPDATE sections
        SET prev_section_id = ?, next_section_id = ?, prev_section_label = ?, next_section_label = ?
        WHERE section_id = ?
        """,
        updates,
    )


def update_chapter_summaries(conn):
    cursor = conn.execute(
        """
        SELECT chapter_id, title_id, section_number, section_range_start, section_range_end
        FROM sections
        WHERE chapter_id IS NOT NULL AND chapter_id != ''
        """
    )
    summaries = {}

    def split_range(value):
        parts = value.split(" to ")
        if len(parts) == 2:
            return parts[0].strip(), parts[1].strip()
        return value, value

    for chapter_id, title_id, section_number, range_start, range_end in cursor.fetchall():
        start_source = range_start or section_number or ""
        end_source = range_end or section_number or ""
        start, _ = split_range(start_source)
        _, end = split_range(end_source)
        summary = summaries.get(
            chapter_id,
            {
                "chapter_id": chapter_id,
                "title_id": title_id,
                "title_id_padded": None,
                "title_id_display": None,
                "chapter_id_padded": None,
                "chapter_id_display": None,
                "section_count": 0,
                "section_start": None,
                "section_end": None,
            },
        )
        if title_id and not summary["title_id"]:
            summary["title_id"] = title_id
        if title_id and not summary["title_id_padded"]:
            summary["title_id_padded"] = format_designator_padded(title_id)
            summary["title_id_display"] = format_designator_display(title_id)
        if not summary["chapter_id_padded"]:
            chapter_raw = chapter_id.replace("chap_", "")
            summary["chapter_id_padded"] = format_designator_padded(chapter_raw)
            summary["chapter_id_display"] = format_designator_display(chapter_raw)
        summary["section_count"] += 1
        if start:
            if not summary["section_start"] or _natural_key(start) < _natural_key(
                summary["section_start"]
            ):
                summary["section_start"] = start
        if end:
            if not summary["section_end"] or _natural_key(end) > _natural_key(
                summary["section_end"]
            ):
                summary["section_end"] = end
        summaries[chapter_id] = summary

    updates = [
        (
            summary["title_id"],
            summary["title_id_padded"],
            summary["title_id_display"],
            summary["chapter_id_padded"],
            summary["chapter_id_display"],
            summary["section_count"],
            summary["section_start"],
            summary["section_end"],
            summary["chapter_id"],
        )
        for summary in summaries.values()
    ]
    conn.executemany(
        """
        UPDATE chapters
        SET title_id = ?, title_id_padded = ?, title_id_display = ?,
            chapter_id_padded = ?, chapter_id_display = ?,
            section_count = ?, section_start = ?, section_end = ?
        WHERE chapter_id = ?
        """,
        updates,
    )


def walk_html_files(root):
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if not name.lower().endswith(".htm"):
                continue
            yield os.path.join(dirpath, name)

def _escape_sql(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def _clean_chapter_title(title):
    if not title:
        return title
    return re.sub(r"^Chapter\s+[^-]+-\s+", "", title, flags=re.IGNORECASE).strip()


def _section_slug(title_id, section_number):
    prefix = f"{title_id}-"
    suffix = section_number[len(prefix) :] if section_number.startswith(prefix) else section_number
    return f"statutes/cgs/section/{title_id}/{suffix}"


def dump_import_sql(conn, output_path):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    sql_lines = []

    # Sources
    sql_lines.append("-- Sources")
    sql_lines.append(
        "INSERT INTO sources (id, name, jurisdiction, region, doc_type, edition, "
        "citation_prefix, slug, sort_order) VALUES ('cgs', "
        "'Connecticut General Statutes', 'state', 'CT', 'statute', NULL, "
        "'Conn. Gen. Stat.', 'cgs', 0);"
    )

    # Levels: Titles
    sql_lines.append("\n-- Levels (Titles)")
    titles = conn.execute(
        """
        SELECT title_id, title_id_padded, title_id_display, title_name
        FROM titles
        ORDER BY title_id_padded
        """
    ).fetchall()

    for idx, (title_id, title_id_padded, title_id_display, title_name) in enumerate(
        titles
    ):
        slug = f"statutes/cgs/title/{title_id}"
        sql_lines.append(
            "INSERT INTO levels (id, source_id, doc_type, level_index, level_name, "
            "label, identifier, identifier_sort, name, parent_id, doc_id, sort_order, slug) "
            f"VALUES ({_escape_sql('lvl_cgs_title_' + title_id)}, 'cgs', 'statute', 0, "
            f"'title', {_escape_sql(title_id_display)}, {_escape_sql(title_id)}, "
            f"{_escape_sql(title_id_padded)}, {_escape_sql(title_name)}, NULL, NULL, {idx}, "
            f"{_escape_sql(slug)});"
        )

    # Levels: Chapters
    sql_lines.append("\n-- Levels (Chapters)")
    chapters = conn.execute(
        """
        SELECT chapter_id, chapter_title, title_id, title_id_padded, title_id_display,
               chapter_id_padded, chapter_id_display, section_count, section_start, section_end
        FROM chapters
        ORDER BY title_id_padded, chapter_id_padded
        """
    ).fetchall()

    for idx, (
        chapter_id,
        chapter_title,
        title_id,
        title_id_padded,
        title_id_display,
        chapter_id_padded,
        chapter_id_display,
        section_count,
        section_start,
        section_end,
    ) in enumerate(chapters):
        name = _clean_chapter_title(chapter_title)
        slug = f"statutes/cgs/chapter/{title_id}/{chapter_id}"
        sql_lines.append(
            "INSERT INTO levels (id, source_id, doc_type, level_index, level_name, "
            "label, identifier, identifier_sort, name, parent_id, doc_id, sort_order, slug) "
            f"VALUES ({_escape_sql('lvl_cgs_chapter_' + chapter_id)}, 'cgs', 'statute', 1, "
            f"'chapter', {_escape_sql(chapter_id_display)}, {_escape_sql(chapter_id)}, "
            f"{_escape_sql(chapter_id_padded)}, {_escape_sql(name)}, "
            f"{_escape_sql('lvl_cgs_title_' + title_id)}, NULL, {idx}, {_escape_sql(slug)});"
        )

    # Documents + Levels: Sections
    sql_lines.append("\n-- Documents (Sections)")
    sections = conn.execute(
        """
        SELECT section_id, chapter_id, title_id, section_number, section_title, section_label,
               see_also, prev_section_id, next_section_id, prev_section_label, next_section_label
        FROM sections
        ORDER BY title_id, section_number
        """
    ).fetchall()

    for idx, (
        section_id,
        chapter_id,
        title_id,
        section_number,
        section_title,
        section_label,
        see_also,
        prev_section_id,
        next_section_id,
        prev_section_label,
        next_section_label,
    ) in enumerate(sections):
        normalized_number = section_number or re.sub(r"^secs?_", "", section_id)
        derived_title_id = title_id or normalized_number.split("-", 1)[0]
        slug = _section_slug(derived_title_id, normalized_number)
        r2_key = f"{slug}.json"
        doc_id = f"doc_cgs_{normalized_number}"
        level_id = f"lvl_cgs_section_{normalized_number}"
        parent_id = (
            f"lvl_cgs_chapter_{chapter_id}" if chapter_id else None
        )

        sql_lines.append(
            "INSERT INTO documents (id, source_id, doc_type, title, citation, slug, as_of, "
            "effective_start, effective_end, source_url, created_at, updated_at) "
            f"VALUES ({_escape_sql(doc_id)}, 'cgs', 'statute', {_escape_sql(section_title)}, "
            f"{_escape_sql(normalized_number)}, {_escape_sql(slug)}, NULL, NULL, NULL, NULL, NULL, NULL);"
        )

        if idx == 0:
            sql_lines.append("\n-- Levels (Sections)")
        sql_lines.append(
            "INSERT INTO levels (id, source_id, doc_type, level_index, level_name, label, "
            "identifier, identifier_sort, name, parent_id, doc_id, sort_order, slug) "
            f"VALUES ({_escape_sql(level_id)}, 'cgs', 'statute', 2, 'section', "
            f"{_escape_sql(section_label)}, {_escape_sql(normalized_number)}, "
            f"{_escape_sql(normalized_number)}, {_escape_sql(section_title)}, "
            f"{_escape_sql(parent_id)}, {_escape_sql(doc_id)}, {idx}, {_escape_sql(slug)});"
        )

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sql_lines))

    print(f"Wrote D1 import SQL to {output_path}")


def dump_r2_content(conn, output_root):
    os.makedirs(output_root, exist_ok=True)

    sections = conn.execute(
        """
        SELECT section_id, title_id, section_number, section_title, body,
               history_short, history_long, citations
        FROM sections
        ORDER BY title_id, section_number
        """
    ).fetchall()

    total = 0
    for (
        section_id,
        title_id,
        section_number,
        section_title,
        body,
        history_short,
        history_long,
        citations,
    ) in sections:
        normalized_number = section_number or re.sub(r"^secs?_", "", section_id)
        derived_title_id = title_id or normalized_number.split("-", 1)[0]
        slug = _section_slug(derived_title_id, normalized_number)
        output_path = os.path.join(output_root, f"{slug}.json")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        blocks = []
        if body:
            blocks.append({"type": "body", "content": body})
        if history_short:
            blocks.append(
                {"type": "history_short", "label": "History", "content": history_short}
            )
        if history_long:
            blocks.append(
                {
                    "type": "history_long",
                    "label": "History Notes",
                    "content": history_long,
                }
            )
        if citations:
            blocks.append(
                {"type": "citations", "label": "Citations", "content": citations}
            )

        content = {
            "version": 2,
            "doc_id": f"doc_cgs_{normalized_number}",
            "doc_type": "statute",
            "blocks": blocks,
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=True, indent=2)

        total += 1
        if total % 1000 == 0:
            print(f"Wrote {total} section files...")

    print(f"Wrote {total} R2 files to {output_root}")


def _level_slug(source_slug, level_type, identifier):
    """Generate slug for a level (title or chapter)."""
    return f"statutes/{source_slug}/{level_type}/{identifier}"


def dump_r2_level_indexes(conn, output_root, source_slug="cgs"):
    """Write index JSON files for each title and chapter."""
    os.makedirs(output_root, exist_ok=True)
    total = 0

    # Title indexes
    titles = conn.execute(
        """
        SELECT title_id, title_id_display, title_name
        FROM titles
        ORDER BY title_id_padded
        """
    ).fetchall()

    for title_id, title_id_display, title_name in titles:
        slug = _level_slug(source_slug, "title", title_id)
        # Get chapters for this title
        chapters = conn.execute(
            """
            SELECT chapter_id, chapter_id_display, chapter_title
            FROM chapters
            WHERE title_id_padded = ?
            ORDER BY chapter_id_padded
            """,
            (format_designator_padded(title_id),),
        ).fetchall()

        title_chapters = [
            {
                "identifier": ch_id,
                "display": ch_display,
                "heading": _clean_chapter_title(ch_title),
            }
            for ch_id, ch_display, ch_title in chapters
        ]

        content = {
            "version": 1,
            "type": "index",
            "level_type": "title",
            "title_id": title_id,
            "title_display": title_id_display,
            "title_name": title_name,
            "chapters": title_chapters,
        }
        output_path = os.path.join(output_root, f"{slug}.json")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=True, indent=2)
        total += 1

    # Chapter indexes
    chapters = conn.execute(
        """
        SELECT chapter_id, chapter_id_display, chapter_title, title_id, title_id_display
        FROM chapters
        ORDER BY title_id_padded, chapter_id_padded
        """
    ).fetchall()

    for chapter_id, chapter_id_display, chapter_title, title_id, title_id_display in chapters:
        slug = _level_slug(source_slug, "chapter", f"{title_id}/{chapter_id}")
        content = {
            "version": 1,
            "type": "index",
            "level_type": "chapter",
            "title_id": title_id,
            "title_display": title_id_display,
            "chapter_id": chapter_id,
            "chapter_display": chapter_id_display,
            "chapter_name": _clean_chapter_title(chapter_title),
        }
        output_path = os.path.join(output_root, f"{slug}.json")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=True, indent=2)
        total += 1

    print(f"Wrote {total} level index files to R2")
    return total


def main():
    parser = argparse.ArgumentParser(
        description="Parse CGA mirror HTML into a SQLite database, one row per section."
    )
    parser.add_argument(
        "--root",
        default="cga_mirror/current/pub",
        help="Root directory containing CGA HTML files.",
    )
    parser.add_argument(
        "--db",
        default="cga_sections.sqlite3",
        help="SQLite database output path.",
    )
    parser.add_argument(
        "--import-sql",
        default="data/d1/import.sql",
        help="D1 import SQL output path.",
    )
    parser.add_argument(
        "--r2-root",
        default="data/r2",
        help="R2 content output root.",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        init_db(conn)
        ingest_titles(conn, args.root)
        total_sections = 0
        for path in walk_html_files(args.root):
            with open(path, "rb") as f:
                html_text = f.read().decode("utf-8", errors="ignore")
            sections = extract_sections_from_html(html_text)
            if not sections:
                continue
            rel_path = os.path.relpath(path, args.root)
            chapter_id = os.path.splitext(os.path.basename(rel_path))[0]
            chapter_title = extract_chapter_title(html_text)
            ingest_chapter(conn, chapter_id, chapter_title)
            ingest_sections(conn, sections, rel_path, chapter_id)
            total_sections += len(sections)
        update_prev_next(conn)
        update_chapter_summaries(conn)
        conn.commit()
        dump_import_sql(conn, args.import_sql)
        dump_r2_content(conn, args.r2_root)
        dump_r2_level_indexes(conn, args.r2_root, source_slug="cgs")
    finally:
        conn.close()

    print(f"Ingested {total_sections} sections into {args.db}")


if __name__ == "__main__":
    main()
