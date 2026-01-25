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
};

export type ChapterSummary = {
  chapter_id: string;
  chapter_title: string;
  section_count: number;
};

export type TitleSummary = {
  title_id: string;
  chapter_count: number;
  section_count: number;
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
    const stmt = db.prepare(
      `
      SELECT
        chapters.chapter_id,
        chapters.chapter_title,
        COUNT(sections.section_id) AS section_count
      FROM chapters
      JOIN sections ON sections.chapter_id = chapters.chapter_id
      WHERE sections.title_id = ?
      GROUP BY chapters.chapter_id, chapters.chapter_title
      ORDER BY chapters.chapter_id
      `
    );
    return stmt.all(titleId) as ChapterSummary[];
  } finally {
    db.close();
  }
}

export function getChapters(): ChapterRecord[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      `
      SELECT chapter_id, chapter_title
      FROM chapters
      ORDER BY chapter_id
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
        title_id,
        COUNT(DISTINCT chapter_id) AS chapter_count,
        COUNT(section_id) AS section_count
      FROM sections
      WHERE title_id IS NOT NULL AND title_id != ''
      GROUP BY title_id
      ORDER BY title_id
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
      SELECT chapter_id, chapter_title
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
