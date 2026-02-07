import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mglAdapter } from "../lib/mgl/adapter";
import { extractSectionCrossReferences } from "../lib/mgl/cross-references";
import { createRateLimiter } from "../lib/mgl/fetcher";
import {
	designatorSortOrder,
	extractVersionIdFromRoot,
	parseChaptersFromTitleResponse,
	parsePartsFromRoot,
	parseSectionContent,
	parseSectionsFromChapterPage,
	parseTitlesFromPart,
} from "../lib/mgl/parser";
import { normalizeMglUrl } from "../lib/mgl/utils";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(__dirname, "fixtures", "mgl", "chapter1");

function loadFixture(filename: string): string {
	return readFileSync(join(fixturesDir, filename), "utf-8");
}

function normalizeText(value: string): string {
	return value
		.replace(/[\u00a0\u202f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(value: string): string {
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

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

function findFirstMismatch(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	for (let i = 0; i < limit; i++) {
		if (a[i] !== b[i]) return i;
	}
	return limit;
}

function contextAt(value: string, index: number): string {
	const start = Math.max(0, index - 30);
	const end = Math.min(value.length, index + 30);
	return value.slice(start, end);
}

function extractBaselineSectionContent(html: string): {
	heading: string;
	body: string;
} {
	const headingMatch = html.match(
		/<h2[^>]*id="skipTo"[^>]*>\s*Section\s*[^:<]+:\s*<small>([\s\S]*?)<\/small>/i,
	);
	const heading = headingMatch
		? normalizeText(decodeHtml(stripTags(headingMatch[1])))
		: "";

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

	const bodyParts = [...contentHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((match) => normalizeText(decodeHtml(stripTags(match[1]))))
		.filter((text) => text.length > 0);

	return {
		heading,
		body: bodyParts.join("\n\n").trim(),
	};
}

describe("MGL parser", () => {
	it("extracts version from disclaimer date", () => {
		const html =
			"This site includes all amendments to the General Laws passed before <strong>January 10</strong><strong>, 2025</strong>, for laws enacted since that time";
		expect(extractVersionIdFromRoot(html)).toBe("2025-01-10");
	});

	it("extracts parts from root page", () => {
		const html = `
			<ul class="generalLawsList">
				<li><a href="/Laws/GeneralLaws/PartI"><span class="part">Part I</span><span class="partTitle">ADMINISTRATION OF THE GOVERNMENT</span></a></li>
				<li><a href="/Laws/GeneralLaws/PartII"><span class="part">Part II</span><span class="partTitle">REAL AND PERSONAL PROPERTY</span></a></li>
			</ul>
		`;

		const parts = parsePartsFromRoot(
			html,
			"https://malegislature.gov/Laws/GeneralLaws",
		);
		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatchObject({
			partCode: "I",
			partId: "1",
			partName: "ADMINISTRATION OF THE GOVERNMENT",
			partUrl: "https://malegislature.gov/laws/generallaws/parti",
		});
	});

	it("extracts titles from part page accordion panels", () => {
		const html = `
			<div id="Ititle" class="panel panel-default">
				<div class="panel-heading">
					<div class="row">
						<div class="col-xs-2">
							<h4 class="glTitle panel-title">
								<a data-toggle="collapse" data-parent="#accordion" href="#titleI" class="fnRemoveClick1" onclick="accordionAjaxLoad('1', '1', 'I')">Title I</a>
							</h4>
						</div>
						<div class="col-xs-10 col-sm-8">
							<h4 class="panel-title">
								<a data-toggle="collapse" data-parent="#accordion" href="#titleI" class="fnRemoveClick1" onclick="accordionAjaxLoad('1', '1', 'I')">JURISDICTION AND EMBLEMS</a>
							</h4>
						</div>
					</div>
				</div>
			</div>
		`;

		const titles = parseTitlesFromPart(html);
		expect(titles).toHaveLength(1);
		expect(titles[0]).toMatchObject({
			titleCode: "I",
			titleId: "1",
			titleName: "JURISDICTION AND EMBLEMS",
		});
	});

	it("extracts chapters from title endpoint response", () => {
		const html = `
			<div id="title" class="panel-collapse fnContentLoaded collapse">
				<ul class="generalLawsList">
					<li><a href="/Laws/GeneralLaws/PartI/TitleI/Chapter1"><span class="chapter">Chapter 1</span><span class="chapterTitle">JURISDICTION</span></a></li>
					<li><a href="/Laws/GeneralLaws/PartI/TitleI/Chapter2A"><span class="chapter">Chapter 2A</span><span class="chapterTitle">EMBLEMS</span></a></li>
				</ul>
			</div>
		`;

		const chapters = parseChaptersFromTitleResponse(
			html,
			"https://malegislature.gov",
		);
		expect(chapters).toHaveLength(2);
		expect(chapters[0].chapterNumber).toBe("1");
		expect(chapters[1].chapterNumber).toBe("2A");
		expect(chapters[1].chapterUrl).toBe(
			"https://malegislature.gov/laws/generallaws/parti/titlei/chapter2a",
		);
	});

	it("extracts sections and section body", () => {
		const chapterHtml = `
			<ul class="generalLawsList">
				<li><a href="/Laws/GeneralLaws/PartI/TitleI/Chapter1/Section1"><span class="section">Section 1</span><span class="sectionTitle">Citizens of commonwealth defined</span></a></li>
				<li><a href="/Laws/GeneralLaws/PartI/TitleI/Chapter1/Section7A"><span class="section">Section 7A</span><span class="sectionTitle">Retrocession</span></a></li>
			</ul>
		`;
		const sections = parseSectionsFromChapterPage(
			chapterHtml,
			"https://malegislature.gov",
		);
		expect(sections).toHaveLength(2);
		expect(sections[1]).toMatchObject({
			sectionNumber: "7A",
			sectionName: "Retrocession",
			sectionUrl:
				"https://malegislature.gov/laws/generallaws/parti/titlei/chapter1/section7a",
		});

		const sectionHtml = `
			<h2 id="skipTo" class="h3 genLawHeading hidden-print">Section 7A: <small>Legislative jurisdiction over property</small></h2>
			<p><p>Section 7A. The governor may accept retrocession.</p>
			<p>A copy of the notice shall be filed with the state secretary.</p>
			</p>
			<script src="/bundles/sidebar?v=abc"></script>
		`;
		const content = parseSectionContent(sectionHtml);
		expect(content.heading).toBe("Legislative jurisdiction over property");
		expect(content.body).toContain(
			"Section 7A. The governor may accept retrocession.",
		);
		expect(content.body).toContain(
			"A copy of the notice shall be filed with the state secretary.",
		);
	});

	it("sorts numeric and suffixed designators", () => {
		expect(designatorSortOrder("2A")).toBeGreaterThan(designatorSortOrder("2"));
		expect(designatorSortOrder("10")).toBeGreaterThan(
			designatorSortOrder("2A"),
		);
	});
});

describe("MGL URL normalization", () => {
	it("normalizes valid URLs and strips fragments", () => {
		expect(
			normalizeMglUrl(
				"/Laws/GeneralLaws/PartI/TitleI/Chapter1#foo",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBe("https://malegislature.gov/laws/generallaws/parti/titlei/chapter1");
	});

	it("rejects disallowed protocols, hostnames, and paths", () => {
		expect(
			normalizeMglUrl(
				"mailto:test@example.com",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBeNull();
		expect(
			normalizeMglUrl(
				"javascript:alert(1)",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBeNull();
		expect(
			normalizeMglUrl(
				"https://example.com/Laws/GeneralLaws/PartI",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBeNull();
		expect(
			normalizeMglUrl(
				"https://malegislature.gov/Bills/Search",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBeNull();
	});
});

describe("MGL hierarchy planning", () => {
	it("builds deterministic parent/child hierarchy for sections", async () => {
		const partHtml = `
			<div id="Ititle" class="panel panel-default">
				<div class="panel-heading">
					<h4 class="panel-title"><a onclick="accordionAjaxLoad('1', '1', 'I')">Title I</a></h4>
					<h4 class="panel-title"><a onclick="accordionAjaxLoad('1', '1', 'I')">JURISDICTION</a></h4>
				</div>
			</div>
		`;
		const titleHtml = `
			<div id="title" class="panel-collapse fnContentLoaded collapse">
				<ul class="generalLawsList">
					<li><a href="/Laws/GeneralLaws/PartI/TitleI/Chapter1"><span class="chapter">Chapter 1</span><span class="chapterTitle">JURISDICTION</span></a></li>
				</ul>
			</div>
		`;
		const chapterHtml = `
			<ul class="generalLawsList">
				<li><a href="/Laws/GeneralLaws/PartI/TitleI/Chapter1/Section7A"><span class="section">Section 7A</span><span class="sectionTitle">Retrocession</span></a></li>
			</ul>
		`;

		const responses = new Map<string, string>([
			["https://malegislature.gov/laws/generallaws/parti", partHtml],
			[
				"https://malegislature.gov/generallaws/getchaptersfortitle?partid=1&titleid=1&code=i",
				titleHtml,
			],
			[
				"https://malegislature.gov/laws/generallaws/parti/titlei/chapter1",
				chapterHtml,
			],
		]);

		const storage = new Map<string, string>();
		const env = {
			MGL_BASE_URL: "https://malegislature.gov",
			MGL_START_PATH: "/Laws/GeneralLaws",
			STORAGE: {
				get: async (key: string) => {
					const value = storage.get(key);
					if (!value) return null;
					return {
						text: async () => value,
					};
				},
				put: async (key: string, value: string) => {
					storage.set(key, value);
				},
			},
		} as unknown as Parameters<typeof mglAdapter.planUnit>[0]["env"];

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const key = typeof input === "string" ? input : input.toString();
			const normalized = key.toLowerCase();
			const body = responses.get(normalized);
			if (!body) {
				return new Response("not found", { status: 404 });
			}
			return new Response(body, { status: 200 });
		}) as typeof fetch;

		try {
			const plan = await mglAdapter.planUnit({
				env,
				root: {
					sourceId: "mgl",
					sourceVersionId: "mgl-2025-01-10",
					canonicalName: "mgl-2025-01-10",
					rootNodeId: "mgl/2025-01-10/root",
					versionId: "2025-01-10",
					rootNode: {
						id: "mgl/2025-01-10/root",
						source_version_id: "mgl-2025-01-10",
						parent_id: null,
						level_name: "root",
						level_index: -1,
						sort_order: 0,
						name: "MGL",
						path: "/statutes/mgl",
						readable_id: "MGL",
						heading_citation: "MGL",
						source_url: null,
						accessed_at: null,
					},
					unitRoots: [],
				},
				unit: {
					id: "part-i",
					partCode: "I",
					partId: "1",
					partName: "ADMINISTRATION",
					partUrl: "https://malegislature.gov/laws/generallaws/parti",
					sortOrder: 1,
				},
			});

			const sectionItem = plan.shardItems.find(
				(item) => item.meta.kind === "section",
			);
			expect(sectionItem).toBeDefined();
			expect(sectionItem?.parentId).toBe(
				"mgl/2025-01-10/root/part-i/title-i/chapter-1",
			);
			expect(sectionItem?.childId).toBe(
				"mgl/2025-01-10/root/part-i/title-i/chapter-1/section-7a",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("MGL cross-references", () => {
	it("extracts chapter/section references", () => {
		const refs = extractSectionCrossReferences(
			"See chapter 268, section 1A and section 7 of chapter 90.",
		);
		expect(refs).toHaveLength(2);
		expect(refs[0]).toMatchObject({
			chapter: "268",
			section: "1A",
			link: "/statutes/mgl/chapter/268/section/1a",
		});
		expect(refs[1]).toMatchObject({
			chapter: "90",
			section: "7",
			link: "/statutes/mgl/chapter/90/section/7",
		});
	});
});

describe("MGL baseline text comparison (medium unit)", () => {
	it("matches parser content against simple baseline across Chapter 1 sections", () => {
		const chapterHtml = loadFixture("chapter.html");
		const sections = parseSectionsFromChapterPage(
			chapterHtml,
			"https://malegislature.gov",
		);
		expect(sections.length).toBeGreaterThanOrEqual(10);

		for (const section of sections) {
			const sectionHtml = loadFixture(`section-${section.sectionNumber}.html`);
			const parsed = parseSectionContent(sectionHtml);
			const baseline = extractBaselineSectionContent(sectionHtml);

			const parserConcatenated = normalizeText(
				`${parsed.heading}\n${parsed.body}`,
			);
			const baselineConcatenated = normalizeText(
				`${baseline.heading}\n${baseline.body}`,
			);

			if (parserConcatenated !== baselineConcatenated) {
				const mismatch = findFirstMismatch(
					parserConcatenated,
					baselineConcatenated,
				);
				const expectedContext = contextAt(baselineConcatenated, mismatch);
				const actualContext = contextAt(parserConcatenated, mismatch);

				throw new Error(
					[
						`Section ID: ${section.sectionNumber}`,
						`First mismatch index: ${mismatch}`,
						`Expected context: ${expectedContext}`,
						`Actual context: ${actualContext}`,
					].join("\n"),
				);
			}
		}
	});
});

describe("MGL fetch limiter", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedules requests at 100ms spacing (10 requests/sec max)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));

		const limiter = createRateLimiter(100);
		const startTimes: number[] = [];

		const makeRequest = async () => {
			await limiter.waitTurn();
			startTimes.push(Date.now());
		};

		const pending = [makeRequest(), makeRequest(), makeRequest()];
		await vi.runAllTimersAsync();
		await Promise.all(pending);

		expect(startTimes).toEqual([
			Date.parse("2025-01-01T00:00:00.000Z"),
			Date.parse("2025-01-01T00:00:00.100Z"),
			Date.parse("2025-01-01T00:00:00.200Z"),
		]);
	});
});
