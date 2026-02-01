"use server";

import { getRequestEvent } from "solid-js/web";
import type {
	ChapterRecord,
	Env,
	SectionContent,
	SectionRecord,
	TitleSummary,
} from "./types";

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event?.nativeEvent?.context?.cloudflare?.env) {
		throw new Error("Cloudflare environment not available");
	}
	return event.nativeEvent.context.cloudflare.env as Env;
}

function getDB(): D1Database {
	return getEnv().DB;
}

function getStorage(): R2Bucket {
	return getEnv().STORAGE;
}

// Helper to format designator for display (remove leading zeros, uppercase suffix)
export function formatDesignator(value: string | null): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toUpperCase();
	const number = String(Number(match[1]));
	const suffix = match[2] ? match[2].toUpperCase() : "";
	return `${number}${suffix}`;
}

// Helper to pad designator for sorting
export function padDesignator(value: string | null, width = 4): string | null {
	if (!value) return value;
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value.toLowerCase();
	const number = match[1].padStart(width, "0");
	const suffix = match[2].toLowerCase();
	return `${number}${suffix}`;
}

// Titles

export async function getTitles(): Promise<TitleSummary[]> {
	const db = getDB();
	const result = await db
		.prepare(
			`
      SELECT
        t.id,
        t.id_padded,
        t.id_display,
        t.name,
        t.sort_order,
        COUNT(DISTINCT s.chapter_id) as chapter_count,
        COUNT(s.id) as section_count
      FROM titles t
      LEFT JOIN sections s ON s.title_id = t.id
      GROUP BY t.id, t.id_padded, t.id_display, t.name, t.sort_order
      ORDER BY t.id_padded, t.sort_order
    `,
		)
		.all<TitleSummary>();
	return result.results;
}

export async function getTitleById(
	titleId: string,
): Promise<TitleSummary | null> {
	const db = getDB();
	const paddedId = padDesignator(titleId);
	const result = await db
		.prepare(
			`
      SELECT
        t.id,
        t.id_padded,
        t.id_display,
        t.name,
        t.sort_order,
        COUNT(DISTINCT s.chapter_id) as chapter_count,
        COUNT(s.id) as section_count
      FROM titles t
      LEFT JOIN sections s ON s.title_id = t.id
      WHERE t.id_padded = ? OR t.id = ? OR LOWER(t.id_display) = LOWER(?)
      GROUP BY t.id, t.id_padded, t.id_display, t.name, t.sort_order
    `,
		)
		.bind(paddedId, titleId, titleId)
		.first<TitleSummary>();
	return result;
}

// Chapters

export async function getChaptersByTitleId(
	titleId: string,
): Promise<ChapterRecord[]> {
	const db = getDB();
	const paddedId = padDesignator(titleId);
	const result = await db
		.prepare(
			`
      SELECT *
      FROM chapters
      WHERE title_id_padded = ? OR title_id = ? OR LOWER(title_id_display) = LOWER(?)
      ORDER BY id_padded, sort_order
    `,
		)
		.bind(paddedId, titleId, titleId)
		.all<ChapterRecord>();
	return result.results;
}

export async function getChapterById(
	chapterId: string,
): Promise<ChapterRecord | null> {
	const db = getDB();
	const paddedId = padDesignator(chapterId);
	const result = await db
		.prepare(
			`
      SELECT *
      FROM chapters
      WHERE id_padded = ? OR id = ? OR LOWER(id_display) = LOWER(?)
    `,
		)
		.bind(paddedId, chapterId, chapterId)
		.first<ChapterRecord>();
	return result;
}

// Sections

export async function getSectionsByChapterId(
	chapterId: string,
): Promise<SectionRecord[]> {
	const db = getDB();
	const paddedId = padDesignator(chapterId);
	const result = await db
		.prepare(
			`
      SELECT s.*
      FROM sections s
      JOIN chapters c ON s.chapter_id = c.id
      WHERE c.id_padded = ? OR c.id = ? OR LOWER(c.id_display) = LOWER(?)
      ORDER BY s.sort_order
    `,
		)
		.bind(paddedId, chapterId, chapterId)
		.all<SectionRecord>();
	return result.results;
}

export async function getSectionById(
	sectionId: string,
): Promise<SectionRecord | null> {
	const db = getDB();
	// Try multiple formats: raw id, with sec_ prefix, section_number
	const result = await db
		.prepare(
			`
      SELECT *
      FROM sections
      WHERE id = ? OR section_number = ?
      LIMIT 1
    `,
		)
		.bind(sectionId, sectionId)
		.first<SectionRecord>();
	return result;
}

export async function getSectionByNumber(
	titleId: string,
	sectionSuffix: string,
): Promise<SectionRecord | null> {
	const db = getDB();
	const sectionNumber = `${titleId}-${sectionSuffix}`;
	const result = await db
		.prepare(
			`
      SELECT *
      FROM sections
      WHERE section_number = ? OR id = ?
      LIMIT 1
    `,
		)
		.bind(sectionNumber, sectionNumber)
		.first<SectionRecord>();
	return result;
}

// R2 Content

export async function getSectionContent(
	r2Key: string,
): Promise<SectionContent | null> {
	const storage = getStorage();
	const object = await storage.get(r2Key);
	if (!object) return null;
	return object.json<SectionContent>();
}

export async function getSectionContentById(
	sectionId: string,
): Promise<SectionContent | null> {
	// First get the section to find its R2 key
	const section = await getSectionById(sectionId);
	if (!section) return null;
	return getSectionContent(section.r2_key);
}
