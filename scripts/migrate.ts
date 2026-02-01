/**
 * Migration script: SQLite -> D1 + R2
 *
 * This script reads from the existing SQLite database and outputs:
 * 1. SQL statements for D1 (titles, chapters, sections metadata)
 * 2. JSON files for R2 (section content blocks)
 *
 * Usage:
 *   npx tsx scripts/migrate.ts
 *
 * Outputs:
 *   - data/d1/import.sql (SQL for D1)
 *   - data/r2/sections/cgs/*.json (R2 content files)
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

interface SQLiteSection {
	section_id: string;
	chapter_id: string;
	title_id: string;
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
}

interface SQLiteChapter {
	chapter_id: string;
	chapter_title: string;
	title_id: string;
	title_id_padded: string | null;
	title_id_display: string | null;
	chapter_id_padded: string | null;
	chapter_id_display: string | null;
	section_count: number | null;
	section_start: string | null;
	section_end: string | null;
}

interface SQLiteTitle {
	title_id: string;
	title_name: string | null;
	title_id_padded: string | null;
	title_id_display: string | null;
}

interface SectionContent {
	version: 1;
	section_id: string;
	blocks: Array<{
		type: string;
		label?: string;
		content: string;
	}>;
}

const padDesignator = (value: string | null, width = 4): string | null => {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const number = match[1].padStart(width, "0");
	const suffix = match[2].toLowerCase();
	return `${number}${suffix}`;
};

const formatDesignator = (value: string | null): string | null => {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toUpperCase();
	const number = String(Number(match[1]));
	const suffix = match[2] ? match[2].toUpperCase() : "";
	return `${number}${suffix}`;
};

const escapeSQL = (value: string | null): string => {
	if (value === null) return "NULL";
	return `'${value.replace(/'/g, "''")}'`;
};

const buildSectionSlug = (titleId: string, sectionNumber: string): string => {
	const sectionSuffix = sectionNumber.replace(`${titleId}-`, "");
	return `statutes/cgs/section/${titleId}/${sectionSuffix}`;
};

async function migrate() {
	const dbPath = path.resolve("cga_sections.sqlite3");
	const db = new Database(dbPath, { readonly: true });

	console.log("Reading from SQLite database...");

	// Read titles
	const titles = db
		.prepare(
			`
    SELECT DISTINCT
      title_id,
      title_name,
      title_id_padded,
      title_id_display
    FROM titles
    ORDER BY title_id_padded
  `,
		)
		.all() as SQLiteTitle[];

	console.log(`Found ${titles.length} titles`);

	// Read chapters
	const chapters = db
		.prepare(
			`
    SELECT
      chapter_id,
      chapter_title,
      title_id,
      title_id_padded,
      title_id_display,
      chapter_id_padded,
      chapter_id_display,
      section_count,
      section_start,
      section_end
    FROM chapters
    ORDER BY title_id_padded, chapter_id_padded
  `,
		)
		.all() as SQLiteChapter[];

	console.log(`Found ${chapters.length} chapters`);

	// Read sections
	const sections = db
		.prepare(
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
    ORDER BY title_id, section_number
  `,
		)
		.all() as SQLiteSection[];

	console.log(`Found ${sections.length} sections`);

	db.close();

	// Create output directories
	await mkdir("data/d1", { recursive: true });
	await mkdir("data/r2", { recursive: true });

	// Generate D1 SQL
	const sqlLines: string[] = [];

	// Sources
	sqlLines.push("-- Sources");
	sqlLines.push(
		`INSERT INTO sources (id, name, jurisdiction, region, doc_type, edition, citation_prefix, slug, sort_order) VALUES ('cgs', 'Connecticut General Statutes', 'state', 'CT', 'statute', NULL, 'Conn. Gen. Stat.', 'cgs', 0);`,
	);

	// Titles
	sqlLines.push("-- Titles");
	for (let i = 0; i < titles.length; i++) {
		const t = titles[i];
		const id = t.title_id;
		const idPadded = t.title_id_padded ?? padDesignator(t.title_id);
		const idDisplay = t.title_id_display ?? formatDesignator(t.title_id);
		const levelId = `lvl_cgs_title_${id}`;

		sqlLines.push(
			`INSERT INTO titles (id, id_padded, id_display, name, sort_order) VALUES (${escapeSQL(id)}, ${escapeSQL(idPadded)}, ${escapeSQL(idDisplay)}, ${escapeSQL(t.title_name)}, ${i});`,
		);

		sqlLines.push(
			`INSERT INTO levels (id, source_id, doc_type, level_index, level_name, label, identifier, identifier_sort, name, parent_id, doc_id, sort_order) VALUES (${escapeSQL(levelId)}, 'cgs', 'statute', 0, 'title', ${escapeSQL(idDisplay)}, ${escapeSQL(id)}, ${escapeSQL(idPadded)}, ${escapeSQL(t.title_name)}, NULL, NULL, ${i});`,
		);
	}

	// Chapters
	sqlLines.push("\n-- Chapters");
	for (let i = 0; i < chapters.length; i++) {
		const c = chapters[i];
		// Clean chapter id (remove chap_ prefix if present for the ID field)
		const id = c.chapter_id;
		const idPadded =
			c.chapter_id_padded ?? padDesignator(c.chapter_id.replace(/^chap_/, ""));
		const idDisplay =
			c.chapter_id_display ??
			formatDesignator(c.chapter_id.replace(/^chap_/, ""));
		const titleId = c.title_id ?? "";
		const titleIdPadded = c.title_id_padded ?? padDesignator(titleId);
		const titleIdDisplay = c.title_id_display ?? formatDesignator(titleId);
		// Clean chapter title (remove "Chapter X - " prefix)
		const name =
			c.chapter_title?.replace(/^Chapter\s+[^-]+-\s+/i, "").trim() ??
			c.chapter_title;
		const levelId = `lvl_cgs_chapter_${id}`;
		const parentId = `lvl_cgs_title_${titleId}`;

		sqlLines.push(
			`INSERT INTO chapters (id, id_padded, id_display, title_id, title_id_padded, title_id_display, name, section_count, section_start, section_end, sort_order) VALUES (${escapeSQL(id)}, ${escapeSQL(idPadded)}, ${escapeSQL(idDisplay)}, ${escapeSQL(titleId)}, ${escapeSQL(titleIdPadded)}, ${escapeSQL(titleIdDisplay)}, ${escapeSQL(name)}, ${c.section_count ?? 0}, ${escapeSQL(c.section_start)}, ${escapeSQL(c.section_end)}, ${i});`,
		);

		sqlLines.push(
			`INSERT INTO levels (id, source_id, doc_type, level_index, level_name, label, identifier, identifier_sort, name, parent_id, doc_id, sort_order) VALUES (${escapeSQL(levelId)}, 'cgs', 'statute', 1, 'chapter', ${escapeSQL(idDisplay)}, ${escapeSQL(id)}, ${escapeSQL(idPadded)}, ${escapeSQL(name)}, ${escapeSQL(parentId)}, NULL, ${i});`,
		);
	}

	// Sections - metadata only
	sqlLines.push("\n-- Sections");
	for (let i = 0; i < sections.length; i++) {
		const s = sections[i];
		const sectionNumber =
			s.section_number ?? s.section_id.replace(/^secs?_/, "");
		const titleId = s.title_id;
		const chapterId = s.chapter_id;
		const slug = buildSectionSlug(titleId, sectionNumber);
		const r2Key = `${slug}.json`;
		const docId = `doc_cgs_${sectionNumber}`;
		const levelId = `lvl_cgs_section_${sectionNumber}`;
		const parentId = `lvl_cgs_chapter_${chapterId}`;

		sqlLines.push(
			`INSERT INTO sections (id, title_id, chapter_id, section_number, section_label, heading, r2_key, see_also, prev_section_id, next_section_id, prev_section_label, next_section_label, sort_order) VALUES (${escapeSQL(s.section_id)}, ${escapeSQL(s.title_id)}, ${escapeSQL(s.chapter_id)}, ${escapeSQL(sectionNumber)}, ${escapeSQL(s.section_label)}, ${escapeSQL(s.section_title)}, ${escapeSQL(r2Key)}, ${escapeSQL(s.see_also)}, ${escapeSQL(s.prev_section_id)}, ${escapeSQL(s.next_section_id)}, ${escapeSQL(s.prev_section_label)}, ${escapeSQL(s.next_section_label)}, ${i});`,
		);

		sqlLines.push(
			`INSERT INTO documents (id, source_id, doc_type, title, citation, slug, as_of, effective_start, effective_end, source_url, created_at, updated_at) VALUES (${escapeSQL(docId)}, 'cgs', 'statute', ${escapeSQL(s.section_title)}, ${escapeSQL(sectionNumber)}, ${escapeSQL(slug)}, NULL, NULL, NULL, ${escapeSQL(s.source_file)}, NULL, NULL);`,
		);

		sqlLines.push(
			`INSERT INTO levels (id, source_id, doc_type, level_index, level_name, label, identifier, identifier_sort, name, parent_id, doc_id, sort_order) VALUES (${escapeSQL(levelId)}, 'cgs', 'statute', 2, 'section', ${escapeSQL(s.section_label)}, ${escapeSQL(sectionNumber)}, ${escapeSQL(sectionNumber)}, ${escapeSQL(s.section_title)}, ${escapeSQL(parentId)}, ${escapeSQL(docId)}, ${i});`,
		);

		// Generate R2 content JSON
		const blocks: SectionContent["blocks"] = [];

		if (s.body) {
			blocks.push({ type: "body", content: s.body });
		}

		if (s.history_short) {
			blocks.push({
				type: "history_short",
				label: "History",
				content: s.history_short,
			});
		}

		if (s.history_long) {
			blocks.push({
				type: "history_long",
				label: "History Notes",
				content: s.history_long,
			});
		}

		if (s.citations) {
			blocks.push({
				type: "citations",
				label: "Citations",
				content: s.citations,
			});
		}

		const content: SectionContent = {
			version: 1,
			section_id: sectionNumber,
			blocks,
		};

		const outputPath = path.join("data/r2", `${slug}.json`);
		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(outputPath, JSON.stringify(content, null, 2));

		if ((i + 1) % 1000 === 0) {
			console.log(`Processed ${i + 1}/${sections.length} sections...`);
		}
	}

	// Write D1 SQL
	await writeFile("data/d1/import.sql", sqlLines.join("\n"));

	console.log("\nMigration complete!");
	console.log(`  - D1 SQL: data/d1/import.sql`);
	console.log(
		`  - R2 content: data/r2/sections/cgs/ (${sections.length} files)`,
	);
	console.log("\nNext steps:");
	console.log("  1. Create D1 database: wrangler d1 create fastlaw");
	console.log(
		"  2. Apply schema: wrangler d1 execute fastlaw --local --file=db/schema.sql",
	);
	console.log(
		"  3. Import data: wrangler d1 execute fastlaw --local --file=data/d1/import.sql",
	);
	console.log(
		"  4. Upload R2 content: wrangler r2 object put statute-content --local --recursive data/r2/",
	);
}

migrate().catch(console.error);
