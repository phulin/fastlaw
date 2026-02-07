import { normalizeMglUrl } from "./utils";

interface MglPart {
	partCode: string;
	partName: string;
	partUrl: string;
	sortOrder: number;
	partId: string;
}

interface MglTitle {
	titleCode: string;
	titleName: string;
	titleId: string;
	sortOrder: number;
}

interface MglChapter {
	chapterNumber: string;
	chapterName: string;
	chapterUrl: string;
	sortOrder: number;
}

interface MglSection {
	sectionNumber: string;
	sectionName: string;
	sectionUrl: string;
	sortOrder: number;
}

interface MglSectionContent {
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
	["VI", 6],
	["VII", 7],
	["VIII", 8],
	["IX", 9],
	["X", 10],
	["XI", 11],
	["XII", 12],
	["XIII", 13],
	["XIV", 14],
	["XV", 15],
	["XVI", 16],
	["XVII", 17],
	["XVIII", 18],
	["XIX", 19],
	["XX", 20],
	["XXI", 21],
	["XXII", 22],
]);

export function extractVersionIdFromRoot(html: string): string {
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

export function parsePartsFromRoot(html: string, baseUrl: string): MglPart[] {
	const parts: MglPart[] = [];
	const seen = new Set<string>();
	const pattern =
		/<li>\s*<a href="([^"]*\/Laws\/GeneralLaws\/Part([IVX]+))">[\s\S]*?<span class="partTitle">([\s\S]*?)<\/span>/gi;

	for (const match of html.matchAll(pattern)) {
		const partUrl = normalizeMglUrl(match[1], baseUrl);
		if (!partUrl) continue;

		const partCode = match[2].toUpperCase();
		if (seen.has(partCode)) continue;
		seen.add(partCode);
		const sortOrder = romanToInt(partCode);
		parts.push({
			partCode,
			partName: normalizeText(match[3]),
			partUrl,
			sortOrder,
			partId: String(sortOrder),
		});
	}

	return parts.sort((a, b) => a.sortOrder - b.sortOrder);
}

export function parseTitlesFromPart(html: string): MglTitle[] {
	const titles: MglTitle[] = [];
	const seen = new Set<string>();
	const panelPattern =
		/<div id="([IVX]+)title" class="panel panel-default">([\s\S]*?)<\/div>\s*<\/div>/gi;

	for (const panelMatch of html.matchAll(panelPattern)) {
		const titleCode = panelMatch[1].toUpperCase();
		if (seen.has(titleCode)) continue;

		const block = panelMatch[2];
		const onclickMatch = block.match(
			/accordionAjaxLoad\('\d+'\s*,\s*'(\d+)'\s*,\s*'([IVX]+)'\)/,
		);
		if (!onclickMatch) continue;

		const titleId = onclickMatch[1];
		const onclickTitleCode = onclickMatch[2].toUpperCase();
		if (onclickTitleCode !== titleCode) continue;

		const nameMatch = block.match(
			/<h4 class="panel-title">\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/h4>/i,
		);
		if (!nameMatch) continue;

		seen.add(titleCode);
		titles.push({
			titleCode,
			titleName: normalizeText(nameMatch[1]),
			titleId,
			sortOrder: Number.parseInt(titleId, 10),
		});
	}

	return titles.sort((a, b) => a.sortOrder - b.sortOrder);
}

export function parseChaptersFromTitleResponse(
	html: string,
	baseUrl: string,
): MglChapter[] {
	const chapters: MglChapter[] = [];
	const seen = new Set<string>();
	const chapterPattern =
		/<li>\s*<a href="([^"]*\/Chapter([^"/]+))">\s*<span class="chapter">\s*Chapter\s*([^<]+)<\/span>\s*<span class="chapterTitle">([\s\S]*?)<\/span>/gi;

	let index = 0;
	for (const match of html.matchAll(chapterPattern)) {
		const chapterUrl = normalizeMglUrl(match[1], baseUrl);
		if (!chapterUrl) continue;

		const chapterNumber = normalizeDesignator(match[3] || match[2]);
		if (seen.has(chapterNumber)) continue;
		seen.add(chapterNumber);

		chapters.push({
			chapterNumber,
			chapterName: normalizeText(match[4]),
			chapterUrl,
			sortOrder: index++,
		});
	}

	return chapters;
}

export function parseSectionsFromChapterPage(
	html: string,
	baseUrl: string,
): MglSection[] {
	const sections: MglSection[] = [];
	const seen = new Set<string>();
	const sectionPattern =
		/<li>\s*<a href="([^"]*\/Section([^"/]+))">\s*<span class="section">\s*Section\s*([^<]+)<\/span>\s*<span class="sectionTitle">([\s\S]*?)<\/span>/gi;

	let index = 0;
	for (const match of html.matchAll(sectionPattern)) {
		const sectionUrl = normalizeMglUrl(match[1], baseUrl);
		if (!sectionUrl) continue;

		const sectionNumber = normalizeDesignator(match[3] || match[2]);
		if (seen.has(sectionNumber)) continue;
		seen.add(sectionNumber);

		sections.push({
			sectionNumber,
			sectionName: normalizeText(match[4]),
			sectionUrl,
			sortOrder: index++,
		});
	}

	return sections;
}

export function parseSectionContent(html: string): MglSectionContent {
	const headingMatch = html.match(
		/<h2[^>]*id="skipTo"[^>]*>\s*Section\s*([^:<]+):\s*<small>([\s\S]*?)<\/small>/i,
	);

	const heading = headingMatch ? normalizeText(headingMatch[2]) : "";
	const contentStart = html.indexOf("</h2>");
	const scriptStart = html.indexOf(
		'<script src="/bundles/sidebar',
		contentStart,
	);
	const footerStart = html.indexOf("<footer>", contentStart);
	const contentEnd =
		scriptStart !== -1
			? scriptStart
			: footerStart !== -1
				? footerStart
				: html.length;
	const contentHtml =
		contentStart === -1 ? "" : html.slice(contentStart + 5, contentEnd);

	const paragraphs = [...contentHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((match) => normalizeText(stripTags(match[1])))
		.filter((text) => text.length > 0);

	return {
		heading,
		body: paragraphs.join("\n\n").trim(),
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
	return decodeHtmlEntities(stripTags(value)).replace(/\s+/g, " ").trim();
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
		.replace(/&#x([\da-fA-F]+);/g, (_, hex) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export type { MglChapter, MglPart, MglSection, MglSectionContent, MglTitle };
