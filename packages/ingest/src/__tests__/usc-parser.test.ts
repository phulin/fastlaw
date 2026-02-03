import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUSCXml, USC_LEVEL_INDEX } from "../lib/usc/parser";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixture(filename: string): string {
	return readFileSync(join(fixturesDir, filename), "utf-8");
}

describe("USC Parser - Title 1", () => {
	const xml = loadFixture("usc_title_1.xml");
	const result = parseUSCXml(xml, "1", "https://uscode.house.gov/");

	it("extracts correct title number", () => {
		expect(result.titleNum).toBe("1");
	});

	it("extracts title name", () => {
		expect(result.titleName).toBe("Title 1");
	});

	it("extracts chapters as organizational levels", () => {
		expect(result.levels.length).toBeGreaterThan(0);
		const chapters = result.levels.filter((l) => l.levelType === "chapter");
		expect(chapters.length).toBe(3);
	});

	it("assigns correct level indices", () => {
		for (const level of result.levels) {
			expect(level.levelIndex).toBe(USC_LEVEL_INDEX[level.levelType]);
		}
	});

	it("extracts sections", () => {
		expect(result.sections.length).toBeGreaterThan(0);
		// Title 1 has around 39 sections
		expect(result.sections.length).toBeGreaterThanOrEqual(35);
	});

	it("extracts section numbers correctly", () => {
		const sectionNums = result.sections.map((s) => s.sectionNum);
		// Title 1 starts with section 1
		expect(sectionNums).toContain("1");
		// Should have sequential sections
		expect(sectionNums).toContain("2");
		expect(sectionNums).toContain("3");
	});

	it("extracts section 1 with correct structure", () => {
		const section1 = result.sections.find((s) => s.sectionNum === "1");
		if (!section1) {
			throw new Error("Section 1 not found");
		}

		// Body content
		expect(section1.body.length).toBeGreaterThan(100);
		expect(section1.body).toContain("meaning");

		// Paths and IDs
		expect(section1.path).toBe("/statutes/usc/section/1/1");
		expect(section1.docId).toBe("doc_usc_1-1");
		expect(section1.levelId).toBe("lvl_usc_section_1-1");

		// Parent linkage (sections in chapter 1 should have chapter parent)
		expect(section1.parentLevelId).toMatch(/^lvl_usc_chapter_/);
	});

	it("extracts source credit as historyShort", () => {
		// At least some sections should have source credits
		const sectionsWithHistory = result.sections.filter(
			(s) => s.historyShort.length > 0,
		);
		expect(sectionsWithHistory.length).toBeGreaterThan(0);
	});

	it("sets chapter identifiers correctly", () => {
		const chapter1 = result.levels.find(
			(l) => l.levelType === "chapter" && l.num === "1",
		);
		if (!chapter1) {
			throw new Error("Chapter 1 not found");
		}
		expect(chapter1.identifier).toBe("1-ch1");
		expect(chapter1.titleNum).toBe("1");
	});

	it("links chapters to title as parent", () => {
		for (const level of result.levels) {
			if (level.levelType === "chapter") {
				expect(level.parentIdentifier).toBe("1-title");
			}
		}
	});
});

describe("USC Parser - Edge Cases", () => {
	it("returns empty results for invalid XML", () => {
		const result = parseUSCXml("<invalid>not usc xml</invalid>", "1", "");
		expect(result.sections).toEqual([]);
		expect(result.levels).toEqual([]);
	});

	it("handles XML with no sections", () => {
		const minimalXml = `<?xml version="1.0"?>
			<uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
				<meta><title>Title 99</title></meta>
				<main><title identifier="/us/usc/t99"></title></main>
			</uscDoc>`;
		const result = parseUSCXml(minimalXml, "99", "");
		expect(result.sections).toEqual([]);
		expect(result.titleNum).toBe("99");
	});
});
