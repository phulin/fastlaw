import path from "node:path";
import Database from "better-sqlite3";

export type SectionRecord = {
  section_id: string;
  chapter_id: string;
  title_id: string | null;
  section_number: string | null;
  section_title: string | null;
  section_label: string;
  section_range_start: string | null;
  section_range_end: string | null;
  body: string;
  history_short: string | null;
  history_long: string | null;
  citations: string | null;
  see_also: string | null;
  prev_section_id: string | null;
  next_section_id: string | null;
  prev_section_label: string | null;
  next_section_label: string | null;
  source_file: string;
};

export type ChapterRecord = {
  chapter_id: string;
  chapter_title: string;
  title_id?: string | null;
  section_count?: number | null;
  section_start?: string | null;
  section_end?: string | null;
  title_id_padded?: string | null;
  title_id_display?: string | null;
  chapter_id_padded?: string | null;
  chapter_id_display?: string | null;
};

export type ChapterSummary = {
  chapter_id: string;
  chapter_title: string;
  section_count: number;
  section_start: string | null;
  section_end: string | null;
  title_id_padded?: string | null;
  title_id_display?: string | null;
  chapter_id_padded?: string | null;
  chapter_id_display?: string | null;
};

export type TitleSummary = {
  title_id: string;
  title_id_padded?: string | null;
  title_id_display?: string | null;
  title_name: string | null;
  chapter_count: number;
  section_count: number;
};

const formatDesignatorPadded = (value: string | null, width = 4) => {
  if (!value) return value;
  const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
  if (!match) return value.toLowerCase();
  const number = match[1].padStart(width, "0");
  const suffix = match[2].toLowerCase();
  return `${number}${suffix}`;
};

const dbPath = path.resolve("cga_sections.sqlite3");

function openDb() {
  return new Database(dbPath, { readonly: true });
}

export function getSectionsByPrefix(prefix: string): SectionRecord[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        section_id,
        chapter_id,
        title_id,
        section_number,
        section_title,
        section_label,
        section_range_start,
        section_range_end,
        body,
        history_short,
        history_long,
        citations,
        see_also,
        prev_section_id,
        next_section_id,
        prev_section_label,
        next_section_label,
        source_file
      FROM sections
      WHERE section_number LIKE ?
      ORDER BY section_number
      `
    );
    return stmt.all(`${prefix}%`) as SectionRecord[];
  } finally {
    db.close();
  }
}

export function getAllSections(): SectionRecord[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        section_id,
        chapter_id,
        title_id,
        section_number,
        section_title,
        section_label,
        section_range_start,
        section_range_end,
        body,
        history_short,
        history_long,
        citations,
        see_also,
        prev_section_id,
        next_section_id,
        prev_section_label,
        next_section_label,
        source_file
      FROM sections
      ORDER BY section_number
      `
    );
    return stmt.all() as SectionRecord[];
  } finally {
    db.close();
  }
}

export function getSectionsByChapterId(chapterId: string): SectionRecord[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        section_id,
        chapter_id,
        title_id,
        section_number,
        section_title,
        section_label,
        section_range_start,
        section_range_end,
        body,
        history_short,
        history_long,
        citations,
        see_also,
        prev_section_id,
        next_section_id,
        prev_section_label,
        next_section_label,
        source_file
      FROM sections
      WHERE chapter_id = ?
      ORDER BY section_number
      `
    );
    return stmt.all(chapterId) as SectionRecord[];
  } finally {
    db.close();
  }
}

export function getChaptersByTitleId(titleId: string): ChapterSummary[] {
  const db = openDb();
  try {
    const paddedTitleId = formatDesignatorPadded(titleId) ?? titleId;
    const stmt = db.prepare(
      `
      SELECT
        chapter_id,
        chapter_title,
        section_count,
        section_start,
        section_end,
        title_id_padded,
        title_id_display,
        chapter_id_padded,
        chapter_id_display
      FROM chapters
      WHERE title_id_padded = ?
      `
    );
    const chapters = stmt.all(paddedTitleId) as ChapterSummary[];
    return chapters.sort((a, b) => {
      if (a.chapter_id_padded && b.chapter_id_padded) {
        const idCompare = a.chapter_id_padded.localeCompare(b.chapter_id_padded);
        if (idCompare !== 0) return idCompare;
      }
      return a.chapter_id.localeCompare(b.chapter_id, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });
  } finally {
    db.close();
  }
}

export function getChapters(): ChapterRecord[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        chapter_id,
        chapter_title,
        title_id,
        title_id_padded,
        title_id_display,
        chapter_id_padded,
        chapter_id_display
      FROM chapters
      ORDER BY chapter_id_padded
      `
    );
    return stmt.all() as ChapterRecord[];
  } finally {
    db.close();
  }
}

export function getTitles(): TitleSummary[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        sections.title_id AS title_id,
        titles.title_name AS title_name,
        titles.title_id_padded AS title_id_padded,
        titles.title_id_display AS title_id_display,
        COUNT(DISTINCT sections.chapter_id) AS chapter_count,
        COUNT(sections.section_id) AS section_count
      FROM sections
      LEFT JOIN titles ON titles.title_id = sections.title_id
      WHERE sections.title_id IS NOT NULL AND sections.title_id != ''
      GROUP BY sections.title_id, titles.title_name, titles.title_id_padded, titles.title_id_display
      `
    );
    return stmt.all() as TitleSummary[];
  } finally {
    db.close();
  }
}

export function getSectionById(sectionId: string): SectionRecord | null {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        section_id,
        chapter_id,
        title_id,
        section_number,
        section_title,
        section_label,
        section_range_start,
        section_range_end,
        body,
        history_short,
        history_long,
        citations,
        see_also,
        prev_section_id,
        next_section_id,
        prev_section_label,
        next_section_label,
        source_file
      FROM sections
      WHERE section_id = ?
      LIMIT 1
      `
    );
    return (stmt.get(sectionId) as SectionRecord) ?? null;
  } finally {
    db.close();
  }
}

export function getSectionByNumber(sectionNumber: string): SectionRecord | null {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        section_id,
        chapter_id,
        title_id,
        section_number,
        section_title,
        section_label,
        section_range_start,
        section_range_end,
        body,
        history_short,
        history_long,
        citations,
        see_also,
        prev_section_id,
        next_section_id,
        prev_section_label,
        next_section_label,
        source_file
      FROM sections
      WHERE section_number = ?
      LIMIT 1
      `
    );
    return (stmt.get(sectionNumber) as SectionRecord) ?? null;
  } finally {
    db.close();
  }
}

export function getChapterById(chapterId: string): ChapterRecord | null {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT
        chapter_id,
        chapter_title,
        title_id,
        title_id_padded,
        title_id_display,
        chapter_id_padded,
        chapter_id_display
      FROM chapters
      WHERE chapter_id = ?
      LIMIT 1
      `
    );
    return (stmt.get(chapterId) as ChapterRecord) ?? null;
  } finally {
    db.close();
  }
}
