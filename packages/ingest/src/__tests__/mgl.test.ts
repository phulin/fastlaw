import { afterEach, describe, expect, it, vi } from "vitest";
import { mglAdapter } from "../lib/mgl/adapter";
import { extractSectionCrossReferences } from "../lib/mgl/cross-references";
import { createRateLimiter } from "../lib/mgl/fetcher";
import {
	designatorSortOrder,
	extractVersionIdFromLandingHtml,
	type MglApiSection,
	parseChapterDetail,
	parsePartDetail,
	parsePartSummary,
	parseSectionContent,
	parseSectionSummary,
} from "../lib/mgl/parser";
import { normalizeMglApiUrl, normalizeMglPublicUrl } from "../lib/mgl/utils";

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function baselineBodyFromApiText(value: string): string {
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

describe("MGL parser", () => {
	it("extracts version from disclaimer date", () => {
		const html =
			"This site includes all amendments to the General Laws passed before <strong>January 10</strong><strong>, 2025</strong>, for laws enacted since that time";
		expect(extractVersionIdFromLandingHtml(html)).toBe("2025-01-10");
	});

	it("parses part/chapter/section API models", () => {
		expect(
			parsePartSummary(
				{ Code: "I", Details: "http://malegislature.gov/api/Parts/I" },
				"https://malegislature.gov/api/parts/i",
			),
		).toMatchObject({
			partCode: "I",
			sortOrder: 1,
		});

		expect(
			parsePartDetail(
				{
					Code: "I",
					Name: "ADMINISTRATION OF THE GOVERNMENT",
					FirstChapter: 1,
					LastChapter: 182,
					Details: "http://malegislature.gov/api/Parts/I",
					Chapters: [],
				},
				"https://malegislature.gov/api/parts/i",
			),
		).toMatchObject({
			partCode: "I",
			partName: "ADMINISTRATION OF THE GOVERNMENT",
		});

		expect(
			parseChapterDetail(
				{
					Code: "2A",
					Name: "EMBLEMS",
					IsRepealed: false,
					StrickenText: null,
					Details: "http://malegislature.gov/api/Chapters/2A",
					Sections: [],
				},
				"https://malegislature.gov/api/chapters/2a",
			),
		).toMatchObject({
			chapterCode: "2A",
			chapterName: "EMBLEMS",
		});

		expect(
			parseSectionSummary(
				{
					Code: "7A",
					ChapterCode: "1",
					Details: "http://malegislature.gov/api/Chapters/1/Sections/7A",
				},
				"https://malegislature.gov/api/chapters/1/sections/7a",
			),
		).toMatchObject({
			sectionCode: "7A",
			chapterCode: "1",
		});
	});

	it("extracts section content from API text", () => {
		const content = parseSectionContent({
			Code: "7A",
			ChapterCode: "1",
			Details: "https://malegislature.gov/api/Chapters/1/Sections/7A",
			Name: "Legislative jurisdiction over property",
			IsRepealed: false,
			Text: "Section 7A. The governor may accept retrocession.\r\n\r\nA copy of the notice shall be filed.",
		});
		expect(content.heading).toBe("Legislative jurisdiction over property");
		expect(content.body).toContain(
			"Section 7A. The governor may accept retrocession.",
		);
		expect(content.body).toContain("A copy of the notice shall be filed.");
	});

	it("sorts numeric and suffixed designators", () => {
		expect(designatorSortOrder("2A")).toBeGreaterThan(designatorSortOrder("2"));
		expect(designatorSortOrder("10")).toBeGreaterThan(
			designatorSortOrder("2A"),
		);
	});
});

describe("MGL URL normalization", () => {
	it("normalizes public and api URLs", () => {
		expect(
			normalizeMglPublicUrl(
				"/Laws/GeneralLaws/Chapter1#foo",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBe("https://malegislature.gov/laws/generallaws/chapter1");
		expect(
			normalizeMglApiUrl(
				"http://malegislature.gov/api/Chapters/1/Sections/1/",
				"https://malegislature.gov",
			),
		).toBe("https://malegislature.gov/api/chapters/1/sections/1");
	});

	it("rejects disallowed protocols, hostnames, and paths", () => {
		expect(
			normalizeMglPublicUrl(
				"mailto:test@example.com",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBeNull();
		expect(
			normalizeMglApiUrl("javascript:alert(1)", "https://malegislature.gov"),
		).toBeNull();
		expect(
			normalizeMglApiUrl(
				"https://example.com/api/Parts/I",
				"https://malegislature.gov",
			),
		).toBeNull();
		expect(
			normalizeMglPublicUrl(
				"https://malegislature.gov/Bills/Search",
				"https://malegislature.gov/Laws/GeneralLaws",
			),
		).toBeNull();
	});
});

describe("MGL hierarchy planning", () => {
	it("builds deterministic parent/child hierarchy for sections", async () => {
		const responses = new Map<string, string>([
			[
				"https://malegislature.gov/api/parts/i",
				JSON.stringify({
					Code: "I",
					Name: "ADMINISTRATION",
					FirstChapter: 1,
					LastChapter: 1,
					Chapters: [
						{
							Code: "1",
							Details: "http://malegislature.gov/api/Chapters/1",
						},
					],
				}),
			],
			[
				"https://malegislature.gov/api/chapters/1",
				JSON.stringify({
					Code: "1",
					Name: "JURISDICTION",
					IsRepealed: false,
					StrickenText: null,
					Details: "http://malegislature.gov/api/Chapters/1",
					Sections: [
						{
							Code: "7A",
							ChapterCode: "1",
							Details: "http://malegislature.gov/api/Chapters/1/Sections/7A",
						},
					],
				}),
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
						json: async () => JSON.parse(value),
					};
				},
				put: async (key: string, value: string) => {
					storage.set(key, value);
				},
			},
		} as unknown as Parameters<typeof mglAdapter.planUnit>[0]["env"];

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const key = (typeof input === "string" ? input : input.toString())
				.toLowerCase()
				.replace(/\/$/, "");
			const body = responses.get(key);
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
					partName: "ADMINISTRATION",
					partApiUrl: "https://malegislature.gov/api/parts/i",
					sortOrder: 1,
				},
			});

			const sectionItem = plan.shardItems.find(
				(item) => item.meta.kind === "section",
			);
			expect(sectionItem).toBeDefined();
			expect(sectionItem?.parentId).toBe(
				"mgl/2025-01-10/root/part-i/chapter-1",
			);
			expect(sectionItem?.childId).toBe(
				"mgl/2025-01-10/root/part-i/chapter-1/section-7a",
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
	it("matches parser content against simple baseline across 10 sections", () => {
		const sections: MglApiSection[] = Array.from({ length: 10 }, (_, index) => {
			const sectionNumber = String(index + 1);
			return {
				Code: sectionNumber,
				ChapterCode: "1",
				Details: `https://malegislature.gov/api/Chapters/1/Sections/${sectionNumber}`,
				Name: `Section ${sectionNumber} heading`,
				IsRepealed: false,
				Text: `Section ${sectionNumber}. Line one.\r\n\r\nLine two with   extra spaces.`,
			};
		});

		for (const section of sections) {
			const parsed = parseSectionContent(section);
			const baseline = {
				heading: section.Name.trim(),
				body: baselineBodyFromApiText(section.Text ?? ""),
			};

			const parserConcatenated = normalizeText(
				`${parsed.heading}\n${parsed.body}`,
			);
			const baselineConcatenated = normalizeText(
				`${baseline.heading}\n${baseline.body}`,
			);
			expect(parserConcatenated).toBe(baselineConcatenated);
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
