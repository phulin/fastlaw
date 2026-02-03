import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getChapterIdFromUrl,
	getTitleIdFromUrl,
	isChapterUrl,
	isTitleUrl,
} from "../lib/cga/crawler";
import {
	ChapterParser,
	extractChapterTitle,
	extractLinks,
	extractSectionsFromHtml,
	formatDesignatorDisplay,
	formatDesignatorPadded,
	normalizeDesignator,
	normalizeLink,
	parseLabel,
} from "../lib/cga/parser";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixture(filename: string): string {
	return readFileSync(join(fixturesDir, filename), "utf-8");
}

// ============================================================
// Parser Unit Tests
// ============================================================

describe("CGA Parser - Designator Formatting", () => {
	describe("formatDesignatorPadded", () => {
		it("pads numeric designators with zeros", () => {
			expect(formatDesignatorPadded("1")).toBe("0001");
			expect(formatDesignatorPadded("42")).toBe("0042");
			expect(formatDesignatorPadded("229")).toBe("0229");
		});

		it("handles designators with letter suffixes", () => {
			expect(formatDesignatorPadded("42a")).toBe("0042a");
			expect(formatDesignatorPadded("377a")).toBe("0377a");
			expect(formatDesignatorPadded("4c")).toBe("0004c");
		});

		it("handles leading zeros in input", () => {
			expect(formatDesignatorPadded("001")).toBe("0001");
			expect(formatDesignatorPadded("042a")).toBe("0042a");
		});

		it("returns null for null input", () => {
			expect(formatDesignatorPadded(null)).toBe(null);
		});

		it("lowercases letter suffixes", () => {
			expect(formatDesignatorPadded("42A")).toBe("0042a");
			expect(formatDesignatorPadded("377A")).toBe("0377a");
		});
	});

	describe("formatDesignatorDisplay", () => {
		it("strips leading zeros", () => {
			expect(formatDesignatorDisplay("001")).toBe("1");
			expect(formatDesignatorDisplay("042")).toBe("42");
		});

		it("handles designators with letter suffixes", () => {
			expect(formatDesignatorDisplay("042a")).toBe("42a");
			expect(formatDesignatorDisplay("377A")).toBe("377a");
		});

		it("returns null for null input", () => {
			expect(formatDesignatorDisplay(null)).toBe(null);
		});
	});

	describe("normalizeDesignator", () => {
		it("strips leading zeros and preserves case", () => {
			expect(normalizeDesignator("001")).toBe("1");
			expect(normalizeDesignator("042A")).toBe("42A");
			expect(normalizeDesignator("042a")).toBe("42a");
		});
	});
});

describe("CGA Parser - Label Parsing", () => {
	describe("parseLabel", () => {
		it("parses single section labels", () => {
			const result = parseLabel("Sec. 1-1. Words and phrases.");
			expect(result.number).toBe("1-1");
			expect(result.title).toBe("Words and phrases.");
			expect(result.rangeStart).toBe("1-1");
			expect(result.rangeEnd).toBe("1-1");
		});

		it("parses range section labels", () => {
			const result = parseLabel("Secs. 1-1o to 1-1s. Reserved");
			expect(result.number).toBe("1-1o to 1-1s");
			expect(result.title).toBe("Reserved");
			expect(result.rangeStart).toBe("1-1o");
			expect(result.rangeEnd).toBe("1-1s");
		});

		it("handles labels without title", () => {
			const result = parseLabel("Sec. 1-15.");
			expect(result.number).toBe("1-15");
			expect(result.title).toBe(null);
		});

		it("returns nulls for invalid labels", () => {
			const result = parseLabel("Invalid label");
			expect(result.number).toBe(null);
			expect(result.title).toBe(null);
		});

		it("returns nulls for null input", () => {
			const result = parseLabel(null);
			expect(result.number).toBe(null);
			expect(result.title).toBe(null);
		});
	});
});

// ============================================================
// Parser Integration Tests
// ============================================================

describe("CGA Parser - Basic Sections", () => {
	const html = loadFixture("basic_chapter.htm");

	it("extracts chapter title", () => {
		const title = extractChapterTitle(html);
		expect(title).toBe("Doulas");
	});

	it("extracts sections from HTML", () => {
		const sections = extractSectionsFromHtml(
			html,
			"377a",
			"https://www.cga.ct.gov/current/pub/chap_377a.htm",
		);
		expect(sections.length).toBe(2);
	});

	it("extracts section stringId correctly", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].stringId).toBe("cgs/section/20-86aa");
		expect(sections[1].stringId).toBe("cgs/section/20-86bb");
	});

	it("extracts section name from TOC", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].name).toContain("Doula advisory committee");
	});

	it("extracts history_short (source class)", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].historyShort).toContain("P.A. 23-147");
	});

	it("extracts history_long (history class)", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].historyLong).toContain("effective July 1, 2023");
	});

	it("extracts citations (annotation class)", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		// Second section has annotation
		expect(sections[1].citations).toContain("doula certification standards");
	});

	it("sets correct parent stringId", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].parentStringId).toBe("cgs/chapter/377a");
	});

	it("sets correct sortOrder", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].sortOrder).toBe(0);
		expect(sections[1].sortOrder).toBe(1);
	});

	it("excludes nav_tbl content from body", () => {
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].body).not.toContain("Return to Chapter");
	});
});

describe("CGA Parser - Reserved Sections", () => {
	const html = loadFixture("reserved_sections.htm");

	it("extracts reserved sections", () => {
		const sections = extractSectionsFromHtml(html, "001", "");
		const reservedSections = sections.filter((s) =>
			s.body.includes("Reserved for future use"),
		);
		expect(reservedSections.length).toBe(2);
	});

	it("marks reserved sections with correct stringId pattern", () => {
		const sections = extractSectionsFromHtml(html, "001", "");
		const reserved = sections.find((s) => s.stringId.includes("1-1o_to_1-1s"));
		expect(reserved).toBeDefined();
	});

	it("extracts TOC label with Reserved marker", () => {
		const parser = new ChapterParser();
		parser.parse(html);
		const labels = parser.getSectionLabels();
		// The section labels are built from TOC anchors
		expect(labels.size).toBeGreaterThan(0);
	});
});

describe("CGA Parser - Transferred Sections", () => {
	const html = loadFixture("transferred_sections.htm");

	it("extracts transferred sections", () => {
		const sections = extractSectionsFromHtml(html, "003", "");
		const transferred = sections.filter((s) =>
			s.body.includes("Transferred to Chapter"),
		);
		expect(transferred.length).toBe(3);
	});

	it("includes transfer destination in body", () => {
		const sections = extractSectionsFromHtml(html, "003", "");
		const sec115 = sections.find((s) => s.stringId === "cgs/section/1-15");
		expect(sec115?.body).toContain("Transferred to Chapter 14, Sec. 1-212");
	});
});

describe("CGA Parser - Repealed Subsections", () => {
	const html = loadFixture("repealed_subsection.htm");

	it("includes repealed subsection text in body", () => {
		const sections = extractSectionsFromHtml(html, "005", "");
		expect(sections.length).toBe(1);
		expect(sections[0].body).toContain("Repealed by P.A. 76-186");
	});

	it("extracts history mentioning the repeal", () => {
		const sections = extractSectionsFromHtml(html, "005", "");
		expect(sections[0].historyLong).toContain("repealed Subsec. (c)");
	});
});

describe("CGA Parser - Tables", () => {
	const html = loadFixture("tables_chapter.htm");

	it("extracts sections containing tables", () => {
		const sections = extractSectionsFromHtml(html, "229", "");
		expect(sections.length).toBe(1);
	});

	it("converts table cells with pipe separators", () => {
		const sections = extractSectionsFromHtml(html, "229", "");
		const body = sections[0].body;
		// Tables should have | separators between cells
		expect(body).toContain("|");
	});

	it("preserves table content like tax rates", () => {
		const sections = extractSectionsFromHtml(html, "229", "");
		const body = sections[0].body;
		expect(body).toContain("Connecticut Taxable Income");
		expect(body).toContain("Rate of Tax");
		expect(body).toContain("3.0%");
		expect(body).toContain("$2,250");
	});

	it("preserves multiple tables in one section", () => {
		const sections = extractSectionsFromHtml(html, "229", "");
		const body = sections[0].body;
		// Second table has $3,500 threshold
		expect(body).toContain("$3,500");
		expect(body).toContain("$105.00");
	});
});

describe("CGA Parser - Nonstandard Level Names", () => {
	it("handles chapter designators with letter suffixes", () => {
		const html = loadFixture("basic_chapter.htm");
		const sections = extractSectionsFromHtml(html, "377a", "");
		expect(sections[0].parentStringId).toBe("cgs/chapter/377a");
	});

	it("formats nonstandard designators correctly for sorting", () => {
		expect(formatDesignatorPadded("42a")).toBe("0042a");
		expect(formatDesignatorPadded("377a")).toBe("0377a");
		expect(formatDesignatorPadded("4c")).toBe("0004c");

		// Sorting order check
		const designators = ["42a", "4c", "377a", "1"];
		const sorted = designators.map((d) => formatDesignatorPadded(d)).sort();
		expect(sorted).toEqual(["0001", "0004c", "0042a", "0377a"]);
	});
});

// ============================================================
// Crawler Unit Tests
// ============================================================

describe("CGA Parser - URL Normalization", () => {
	const BASE = "https://www.cga.ct.gov/current/pub";

	describe("normalizeLink", () => {
		it("normalizes URL path to lowercase", () => {
			// Uppercase article links should be normalized to lowercase
			const result = normalizeLink("art_002A.htm", `${BASE}/art_002a.htm`);
			expect(result).toBe(`${BASE}/art_002a.htm`);
		});

		it("normalizes mixed case paths consistently", () => {
			const lowercase = normalizeLink("art_002a.htm", `${BASE}/title_42a.htm`);
			const uppercase = normalizeLink("art_002A.htm", `${BASE}/title_42a.htm`);
			// Both should resolve to the same lowercase URL
			expect(lowercase).toBe(uppercase);
			expect(lowercase).toBe(`${BASE}/art_002a.htm`);
		});

		it("normalizes absolute URLs with mixed case", () => {
			const result = normalizeLink(
				`${BASE}/art_004A.htm`,
				`${BASE}/title_42a.htm`,
			);
			expect(result).toBe(`${BASE}/art_004a.htm`);
		});

		it("strips fragment identifiers", () => {
			const result = normalizeLink(
				"art_002A.htm#sec_42a-2A-404",
				`${BASE}/art_002a.htm`,
			);
			expect(result).toBe(`${BASE}/art_002a.htm`);
		});

		it("rejects non-CGA domains", () => {
			const result = normalizeLink(
				"https://example.com/page.htm",
				`${BASE}/title_42a.htm`,
			);
			expect(result).toBe(null);
		});

		it("rejects paths outside /current/pub/", () => {
			const result = normalizeLink(
				"/other/path/page.htm",
				`${BASE}/title_42a.htm`,
			);
			expect(result).toBe(null);
		});

		it("rejects mailto and javascript links", () => {
			expect(normalizeLink("mailto:test@example.com", `${BASE}/page.htm`)).toBe(
				null,
			);
			expect(normalizeLink("javascript:void(0)", `${BASE}/page.htm`)).toBe(
				null,
			);
		});
	});
});

describe("CGA Crawler - URL Parsing", () => {
	const BASE = "https://www.cga.ct.gov/current/pub";

	describe("getChapterIdFromUrl", () => {
		it("extracts chapter ID from chapter URL", () => {
			expect(getChapterIdFromUrl(`${BASE}/chap_001.htm`)).toBe("chap_001");
			expect(getChapterIdFromUrl(`${BASE}/chap_377a.htm`)).toBe("chap_377a");
		});

		it("returns null for non-chapter URLs", () => {
			expect(getChapterIdFromUrl(`${BASE}/title_01.htm`)).toBe(null);
			expect(getChapterIdFromUrl(`${BASE}/titles.htm`)).toBe(null);
		});
	});

	describe("getTitleIdFromUrl", () => {
		it("extracts title ID from title URL", () => {
			expect(getTitleIdFromUrl(`${BASE}/title_01.htm`)).toBe("01");
			expect(getTitleIdFromUrl(`${BASE}/title_42a.htm`)).toBe("42a");
		});

		it("returns null for non-title URLs", () => {
			expect(getTitleIdFromUrl(`${BASE}/chap_001.htm`)).toBe(null);
			expect(getTitleIdFromUrl(`${BASE}/titles.htm`)).toBe(null);
		});
	});

	describe("isChapterUrl / isTitleUrl", () => {
		it("correctly identifies chapter URLs", () => {
			expect(isChapterUrl(`${BASE}/chap_001.htm`)).toBe(true);
			expect(isChapterUrl(`${BASE}/title_01.htm`)).toBe(false);
		});

		it("correctly identifies title URLs", () => {
			expect(isTitleUrl(`${BASE}/title_01.htm`)).toBe(true);
			expect(isTitleUrl(`${BASE}/chap_001.htm`)).toBe(false);
		});
	});
});

// ============================================================
// ChapterParser Class Tests
// ============================================================

describe("ChapterParser", () => {
	it("parses chapter title from HTML title tag", () => {
		const html = loadFixture("basic_chapter.htm");
		const parser = new ChapterParser();
		parser.parse(html);
		expect(parser.getChapterTitle()).toBe("Doulas");
	});

	it("extracts sections with correct data", () => {
		const html = loadFixture("basic_chapter.htm");
		const parser = new ChapterParser();
		parser.parse(html);
		const sections = parser.getSections();
		expect(sections.length).toBe(2);
		expect(sections[0].sectionId).toBe("sec_20-86aa");
	});

	it("builds TOC map from anchor links", () => {
		const html = loadFixture("basic_chapter.htm");
		const parser = new ChapterParser();
		parser.parse(html);
		const labels = parser.getSectionLabels();
		expect(labels.get("sec_20-86aa")).toContain("Doula advisory committee");
	});

	it("separates content into parts (body, history, citations)", () => {
		const html = loadFixture("basic_chapter.htm");
		const parser = new ChapterParser();
		parser.parse(html);
		const sections = parser.getSections();

		// First section should have body content
		expect(sections[0].parts.body.length).toBeGreaterThan(0);
		// Should have history_short from source class
		expect(sections[0].parts.history_short.length).toBeGreaterThan(0);
	});
});

// ============================================================
// Title 42a (Uniform Commercial Code) - Articles instead of Chapters
// ============================================================

describe("CGA Parser - Title 42a Articles", () => {
	it("extracts article links from title_42a page", () => {
		const html = loadFixture("title_42a.htm");
		const links = extractLinks(
			html,
			"https://www.cga.ct.gov/current/pub/title_42a.htm",
		);
		// Should find art_001.htm, art_002.htm, art_002a.htm links
		const articleLinks = links.filter((link) => link.includes("/art_"));
		expect(articleLinks.length).toBeGreaterThanOrEqual(3);
		expect(articleLinks.some((l) => l.includes("art_001.htm"))).toBe(true);
		expect(articleLinks.some((l) => l.includes("art_002.htm"))).toBe(true);
	});

	it("extracts sections from article page", () => {
		const html = loadFixture("art_001.htm");
		const sections = extractSectionsFromHtml(
			html,
			"001",
			"https://www.cga.ct.gov/current/pub/art_001.htm",
		);
		expect(sections.length).toBe(2);
	});

	it("extracts correct stringId for 42a sections", () => {
		const html = loadFixture("art_001.htm");
		const sections = extractSectionsFromHtml(html, "001", "");
		// Section IDs should preserve the 42a- prefix
		expect(sections[0].stringId).toBe("cgs/section/42a-1-101");
		expect(sections[1].stringId).toBe("cgs/section/42a-1-102");
	});

	it("extracts section name from TOC for 42a sections", () => {
		const html = loadFixture("art_001.htm");
		const sections = extractSectionsFromHtml(html, "001", "");
		expect(sections[0].name).toContain("Short titles");
		expect(sections[1].name).toContain("Scope of article");
	});

	it("extracts history and citations for 42a sections", () => {
		const html = loadFixture("art_001.htm");
		const sections = extractSectionsFromHtml(html, "001", "");
		expect(sections[0].historyShort).toContain("1959, P.A. 133");
		expect(sections[0].historyLong).toContain("P.A. 05-109");
		expect(sections[1].citations).toContain("172 C. 112");
	});

	it("sets correct parent stringId for articles", () => {
		const html = loadFixture("art_001.htm");
		const sections = extractSectionsFromHtml(html, "1", "", "article");
		// For articles, parentStringId should reference cgs/article/...
		expect(sections[0].parentStringId).toBe("cgs/article/1");
	});

	it("sets correct parent stringId for chapters (default)", () => {
		const html = loadFixture("basic_chapter.htm");
		const sections = extractSectionsFromHtml(html, "377a", "");
		// For chapters, parentStringId should reference cgs/chapter/...
		expect(sections[0].parentStringId).toBe("cgs/chapter/377a");
	});
});

// ============================================================
// Framework Extension Points (for other crawlers)
// ============================================================

describe("Crawler Framework - Extension Points", () => {
	// These tests document the interface that other crawlers should implement

	it("ParsedSection interface has required fields", () => {
		const html = loadFixture("basic_chapter.htm");
		const sections = extractSectionsFromHtml(
			html,
			"377a",
			"http://example.com",
		);
		const section = sections[0];

		// Required fields for DB insertion
		expect(section).toHaveProperty("stringId");
		expect(section).toHaveProperty("levelName");
		expect(section).toHaveProperty("levelIndex");
		expect(section).toHaveProperty("name");
		expect(section).toHaveProperty("path");
		expect(section).toHaveProperty("readableId");
		expect(section).toHaveProperty("body");
		expect(section).toHaveProperty("parentStringId");
		expect(section).toHaveProperty("sortOrder");
		expect(section).toHaveProperty("sourceUrl");

		// Optional metadata fields
		expect(section).toHaveProperty("historyShort");
		expect(section).toHaveProperty("historyLong");
		expect(section).toHaveProperty("citations");
		expect(section).toHaveProperty("seeAlso");
	});

	it("Section levelIndex is consistent", () => {
		const html = loadFixture("basic_chapter.htm");
		const sections = extractSectionsFromHtml(html, "377a", "");
		// All sections should have levelIndex 2 (after root=0, title/chapter=1)
		for (const section of sections) {
			expect(section.levelIndex).toBe(2);
		}
	});
});
