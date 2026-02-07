export interface MglApiPartSummary {
	Code: string;
	Details: string;
}

export interface MglApiChapterSummary {
	Code: string;
	Details: string;
}

export interface MglApiSectionSummary {
	Code: string;
	ChapterCode: string;
	Details: string;
}

export interface MglApiPart extends MglApiPartSummary {
	Name: string;
	FirstChapter: number;
	LastChapter: number;
	Chapters: MglApiChapterSummary[];
}

export interface MglApiChapter extends MglApiChapterSummary {
	Name: string;
	IsRepealed: boolean;
	StrickenText: string | null;
	Sections: MglApiSectionSummary[];
}

export interface MglApiSection extends MglApiSectionSummary {
	Name: string;
	IsRepealed: boolean;
	Text: string | null;
}

export interface MglPart {
	partCode: string;
	partName: string;
	partApiUrl: string;
	sortOrder: number;
}

export interface MglChapter {
	chapterCode: string;
	chapterName: string;
	chapterApiUrl: string;
	sortOrder: number;
}

export interface MglSection {
	sectionCode: string;
	chapterCode: string;
	sectionApiUrl: string;
	sortOrder: number;
}

export interface MglSectionContent {
	heading: string;
	body: string;
}

const MONTH_INDEX = new Map<string, string>([
	["january", "01"],
	["february", "02"],
	["march", "03"],
	["april", "04"],
	["may", "05"],
	["june", "06"],
	["july", "07"],
	["august", "08"],
	["september", "09"],
	["october", "10"],
	["november", "11"],
	["december", "12"],
]);

const ROMAN_TO_INT = new Map<string, number>([
	["I", 1],
	["II", 2],
	["III", 3],
	["IV", 4],
	["V", 5],
]);

export function extractVersionIdFromLandingHtml(html: string): string {
	const amendmentMatch = html.match(
		/This site includes all amendments to the General Laws passed before\s*<strong>\s*([A-Za-z]+)\s+(\d{1,2})\s*<\/strong>\s*<strong>\s*,\s*(\d{4})\s*<\/strong>/i,
	);
	if (amendmentMatch) {
		const month = MONTH_INDEX.get(amendmentMatch[1].toLowerCase()) ?? "01";
		const day = amendmentMatch[2].padStart(2, "0");
		const year = amendmentMatch[3];
		return `${year}-${month}-${day}`;
	}

	const copyrightMatch = html.match(/Copyright\s*&copy;\s*(\d{4})/i);
	if (copyrightMatch) {
		return `${copyrightMatch[1]}-01-01`;
	}

	return new Date().toISOString().slice(0, 10);
}

export function parsePartSummary(
	input: MglApiPartSummary,
	apiUrl: string,
): MglPart {
	const partCode = normalizeDesignator(input.Code);
	return {
		partCode,
		partName: "",
		partApiUrl: apiUrl,
		sortOrder: romanToInt(partCode),
	};
}

export function parsePartDetail(input: MglApiPart, apiUrl: string): MglPart {
	const partCode = normalizeDesignator(input.Code);
	return {
		partCode,
		partName: normalizeText(input.Name),
		partApiUrl: apiUrl,
		sortOrder: romanToInt(partCode),
	};
}

export function parseChapterDetail(
	input: MglApiChapter,
	apiUrl: string,
): MglChapter {
	const chapterCode = normalizeDesignator(input.Code);
	return {
		chapterCode,
		chapterName: normalizeText(input.Name),
		chapterApiUrl: apiUrl,
		sortOrder: designatorSortOrder(chapterCode),
	};
}

export function parseSectionSummary(
	input: MglApiSectionSummary,
	apiUrl: string,
): MglSection {
	const sectionCode = normalizeDesignator(input.Code);
	const chapterCode = normalizeDesignator(input.ChapterCode);
	return {
		sectionCode,
		chapterCode,
		sectionApiUrl: apiUrl,
		sortOrder: designatorSortOrder(sectionCode),
	};
}

export function parseSectionContent(input: MglApiSection): MglSectionContent {
	return {
		heading: normalizeText(input.Name),
		body: normalizeBodyText(input.Text ?? ""),
	};
}

export function designatorSortOrder(value: string): number {
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return Number.MAX_SAFE_INTEGER;
	const numeric = Number.parseInt(match[1], 10);
	const suffix = match[2].toLowerCase();
	let suffixValue = 0;
	for (const char of suffix) {
		const offset = char.charCodeAt(0) - 96;
		suffixValue = suffixValue * 27 + offset;
	}
	return numeric * 100000 + suffixValue;
}

function romanToInt(value: string): number {
	const mapped = ROMAN_TO_INT.get(value.toUpperCase());
	if (!mapped) {
		throw new Error(`Unknown Roman numeral: ${value}`);
	}
	return mapped;
}

function normalizeDesignator(value: string): string {
	return value.trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeBodyText(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\u00a0\u202f]/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
