import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";
import { type Paragraph, ParagraphRange } from "../types";
import { createParagraph } from "./test-utils";

interface SelectedInstructionBlock {
	citation: string;
	sectionPath: string;
	instructionText: string;
	instructionLineLevels: number[];
	expectedEditedExcerpt: string;
}

interface LeveledLine {
	text: string;
	level: number;
}

const LEVEL_TO_XSTART = 24;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");

const fixturePathFromSectionPath = (sectionPath: string): string => {
	const parts = sectionPath.split("/").filter((part) => part.length > 0);
	const sectionIndex = parts.indexOf("section");
	if (sectionIndex < 0) {
		throw new Error(`Invalid section path: ${sectionPath}`);
	}
	const title = parts[sectionIndex + 1];
	const section = parts[sectionIndex + 2];
	if (!title || !section) {
		throw new Error(`Unable to resolve title/section from: ${sectionPath}`);
	}
	return resolve(
		WEB_ROOT,
		`src/lib/__fixtures__/usc-${title}-${section}-full.md`,
	);
};

const splitFixtureLines = (text: string): string[] =>
	text
		.split("\n")
		.map((rawLine) => rawLine.trim())
		.filter((line) => line.length > 0);

const toLeveledLines = (
	text: string,
	lineLevels: readonly number[],
): LeveledLine[] => {
	const lines = splitFixtureLines(text);
	if (lines.length !== lineLevels.length) {
		throw new Error(
			`Line count mismatch: got ${lines.length} lines and ${lineLevels.length} levels.`,
		);
	}
	const minLevel =
		lineLevels.length === 0 ? 0 : Math.min(...lineLevels.map((level) => level));
	return lines.map((line, index) => ({
		text: line,
		level: (lineLevels[index] ?? 0) - minLevel,
	}));
};

const createInstructionParagraphs = (
	instructionText: string,
	lineLevels: readonly number[],
): Paragraph[] =>
	toLeveledLines(instructionText, lineLevels).map((line, index) =>
		createParagraph(line.text, {
			level: line.level,
			y: 780 - index * 12,
			lines: [
				{
					xStart: line.level * LEVEL_TO_XSTART,
					y: 780 - index * 12,
					page: 1,
				},
			],
		}),
	);

const resolveRangeFromParagraphs = (
	paragraphs: readonly Paragraph[],
	start: number,
	end: number,
): ParagraphRange => {
	let cursor = 0;
	let startIndex = 0;
	let endIndex = paragraphs.length - 1;
	let startFirst = 0;
	let endLast = 0;

	for (let i = 0; i < paragraphs.length; i += 1) {
		const paragraph = paragraphs[i];
		if (!paragraph) continue;
		const lineStart = cursor;
		const lineEnd = lineStart + paragraph.text.length;

		if (start >= lineStart && start <= lineEnd) {
			startIndex = i;
			startFirst = start - lineStart;
		}
		if (end >= lineStart && end <= lineEnd) {
			endIndex = i;
			endLast = end - lineStart;
			break;
		}
		cursor = lineEnd + 1;
	}

	return new ParagraphRange(
		paragraphs.slice(startIndex, endIndex + 1),
		startFirst,
		endLast,
	);
};

const SELECTED_INSTRUCTION_BLOCKS: SelectedInstructionBlock[] = [
	{
		citation: "7 U.S.C. 2012(u)",
		sectionPath: "/statutes/usc/section/7/2012",
		instructionText: `(a) IN GENERAL.—Section 3 of the Food and Nutrition Act of 2008 (7 U.S.C. 2012) is amended by striking subsection (u) and inserting the following:
“(u) THRIFTY FOOD PLAN.—
“(1) IN GENERAL.—The term ‘thrifty food plan’ means the diet...”`,
		instructionLineLevels: [1, 1, 2],
		expectedEditedExcerpt: "(u) THRIFTY FOOD PLAN.—",
	},
	{
		citation: "7 U.S.C. 2015(o)(4)",
		sectionPath: "/statutes/usc/section/7/2015/o",
		instructionText: `(b) STANDARDIZING ENFORCEMENT.—Section 6(o)(4) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(o)(4)) is amended—
(1) in subparagraph (A), by striking clause (ii) and inserting the following:
“(ii) is in a noncontiguous State and has an unemployment rate that is at or above 1.5 times the national unemployment rate.”; and
(2) by adding at the end the following:
“(C) DEFINITION OF NONCONTIGUOUS STATE.—
“(i) IN GENERAL.—In this paragraph, the term 'noncontiguous State' means a State that is not 1 of the contiguous 48 States or the District of Columbia.
“(ii) EXCLUSIONS.—The term 'noncontiguous State' does not include Guam or the Virgin Islands of the United States.”.`,
		instructionLineLevels: [1, 2, 5, 2, 3, 4, 4],
		expectedEditedExcerpt: `(ii) is in a noncontiguous State and has an unemployment rate that is at or above 1.5 times the national unemployment rate.

(B) Report

The Secretary shall report the basis for a waiver under subparagraph (A) to the Committee on Agriculture of the House of Representatives and the Committee on Agriculture, Nutrition, and Forestry of the Senate.
(C) DEFINITION OF NONCONTIGUOUS STATE.—`,
	},
	{
		citation: "7 U.S.C. 2015(f)",
		sectionPath: "/statutes/usc/section/7/2015/f",
		instructionText: `Section 6(f) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(f)) is amended to read as follows:
“(f) No individual who is a member of a household otherwise eligible to participate in the supplemental nutrition assistance program under this section shall be eligible to participate in the supplemental nutrition assistance program as a member of that or any other household unless he or she is—
“(1) a resident of the United States; and
“(2) either—
“(A) a citizen or national of the United States;
“(B) an alien lawfully admitted for permanent residence as an immigrant as defined by sections 101(a)(15) and 101(a)(20) of the Immigration and Nationality Act, excluding, among others, alien visitors, tourists, diplomats, and students who enter the United States temporarily with no intention of abandoning their residence in a foreign country;
“(C) an alien who has been granted the status of Cuban and Haitian entrant, as defined in section 501(e) of the Refugee Education Assistance Act of 1980 (Public Law 96–422); or
“(D) an individual who lawfully resides in the United States in accordance with a Compact of Free Association referred to in section 402(b)(2)(G) of the Personal Responsibility and Work Opportunity Reconciliation Act of 1996.
The income (less, at State option, a pro rata share) and financial resources of the individual rendered ineligible to participate in the supplemental nutrition assistance program under this subsection shall be considered in determining the eligibility and the value of the allotment of the household of which such individual is a member.”.`,
		instructionLineLevels: [0, 1, 2, 2, 3, 3, 3, 3, 1],
		expectedEditedExcerpt: "(A) a citizen or national of the United States;",
	},
	{
		citation: "7 U.S.C. 2015(o)",
		sectionPath: "/statutes/usc/section/7/2015/o",
		instructionText: `(c) WAIVER FOR NONCONTIGUOUS STATES.—Section 6(o) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(o)) is amended—
(1) by redesignating paragraph (7) as paragraph (8); and
(2) by inserting after paragraph (6) the following:
“(7) EXEMPTION FOR NONCONTIGUOUS STATES.—”`,
		instructionLineLevels: [1, 2, 2, 3],
		expectedEditedExcerpt: "(8) Other program rules",
	},
	{
		citation: "7 U.S.C. 2013(a)",
		sectionPath: "/statutes/usc/section/7/2013/a",
		instructionText: `(a) IN GENERAL.—Section 4(a) of the Food and Nutrition Act of 2008 (7 U.S.C. 2013(a)) is amended—
(1) by striking “(a) Subject to” and inserting the following:
“(a) PROGRAM.—
“(1) ESTABLISHMENT.—Subject to”; and
(2) by adding at the end the following:
“(2) STATE QUALITY CONTROL INCENTIVE.—”`,
		instructionLineLevels: [1, 2, 1, 2, 2, 2],
		expectedEditedExcerpt: "(2) STATE QUALITY CONTROL INCENTIVE.—",
	},
	{
		citation: "7 U.S.C. 9011(8)(B)(ii)",
		sectionPath: "/statutes/usc/section/7/9011/8/B",
		instructionText: `(a) EFFECTIVE REFERENCE PRICE.—Section 1111(8)(B)(ii) of the Agricultural Act of 2014 (7 U.S.C. 9011(8)(B)(ii)) is amended by striking “85” and inserting “beginning with the crop year 2025, 88”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: "beginning with the crop year 2025, 88",
	},
	{
		citation: "7 U.S.C. 9015",
		sectionPath: "/statutes/usc/section/7/9015",
		instructionText: `(a) IN GENERAL.—Section 1115 of the Agricultural Act of 2014 (7 U.S.C. 9015) is amended—
(1) in subsection (a), in the matter preceding paragraph (1), by striking “2023” and inserting “2031”;`,
		instructionLineLevels: [1, 2],
		expectedEditedExcerpt: "for the 2019 through 2031 crop years",
	},
	{
		citation: "7 U.S.C. 9034",
		sectionPath: "/statutes/usc/section/7/9034/b",
		instructionText: `Section 1204 of the Agricultural Act of 2014 (7 U.S.C. 9034) is amended—
(1) in subsection (b)—
(A) by redesignating paragraph (1) as subparagraph (A) and indenting appropriately;
(B) in the matter preceding subparagraph (A) (as so redesignated), by striking “The Secretary” and inserting the following:
“(1) IN GENERAL.—The Secretary”; and
(C) by striking paragraph (2) and inserting the following:
“(B)(i) in the case of long grain rice and medium grain rice, the prevailing world market price for the commodity, as determined and adjusted by the Secretary in accordance with this section; or
“(ii) in the case of upland cotton, the prevailing world market price for the commodity, as determined and adjusted by the Secretary in accordance with this section.
“(2) REFUND FOR UPLAND COTTON.—”`,
		instructionLineLevels: [0, 2, 3, 3, 2, 3, 3, 4, 2],
		expectedEditedExcerpt: "(2) REFUND FOR UPLAND COTTON.—",
	},
	{
		citation: "7 U.S.C. 2036(a)(2)",
		sectionPath: "/statutes/usc/section/7/2036/a",
		instructionText: `(3) Section 27(a)(2) of the Food and Nutrition Act of 2008 (7 U.S.C. 2036(a)(2))) is amended by striking “section 3(u)(4)” each place it appears and inserting “section 3(u)(3)”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: "section 3(u)(3)",
	},
	{
		citation: "42 U.S.C. 1396o-1(a)(1)",
		sectionPath: "/statutes/usc/section/42/1396o-1/a",
		instructionText: `(2) NONAPPLICABILITY OF ALTERNATIVE COST SHARING.—Section 1916A(a)(1) of the Social Security Act (42 U.S.C. 1396o–1(a)(1)) is amended, in the second sentence, by striking “or (j)” and inserting “(j), or (k)”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: "(j), or (k)",
	},
	{
		citation: "7 U.S.C. 9038(a)",
		sectionPath: "/statutes/usc/section/7/9038/a",
		instructionText: `(e) SPECIAL COMPETITIVE PROVISIONS FOR EXTRA LONG STAPLE COTTON.—Section 1208(a) of the Agricultural Act of 2014 (7 U.S.C. 9038(a)) is amended, in the matter preceding paragraph (1), by striking “2026” and inserting “2032”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: "through July 31, 2032",
	},
	{
		citation: "7 U.S.C. 1516(b)(2)(C)(i)",
		sectionPath: "/statutes/usc/section/7/1516/b/2/C",
		instructionText: `Section 516(b)(2)(C)(i) of the Federal Crop Insurance Act (7 U.S.C. 1516(b)(2)(C)(i)) is amended, in the matter preceding subclause (I), by striking “for each fiscal year” and inserting “for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter",
	},
	{
		citation: "7 U.S.C. 9036",
		sectionPath: "/statutes/usc/section/7/9036",
		instructionText: `(2) PAYMENTS IN LIEU OF LDPS.—Section 1206 of the Agricultural Act of 2014 (7 U.S.C. 9036) is amended, in subsections (a) and (d), by striking “2023” each place it appears and inserting “2031”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"Effective for each of the 2014 through 2031 crop years",
	},
	{
		citation: "7 U.S.C. 1308-3a(d)",
		sectionPath: "/statutes/usc/section/7/1308-3a/d",
		instructionText: `(e) EXCLUSION FROM AGI CALCULATION.—Section 1001D(d) of the Food Security Act of 1985 (7 U.S.C. 1308–3a(d)) is amended by striking “, general partnership, or joint venture” each place it appears.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"to an entity, the amount of the payment or benefit shall be reduced",
	},
];

for (const sample of SELECTED_INSTRUCTION_BLOCKS) {
	test(`HR1 Integration Diverse: ${sample.citation}`, () => {
		const parser = createHandcraftedInstructionParser();
		const instructionParagraphs = createInstructionParagraphs(
			sample.instructionText,
			sample.instructionLineLevels,
		);
		const instructionLines = instructionParagraphs.map((p) => p.text);
		const parsed = parser.parseInstructionFromLines(
			instructionLines,
			0,
			(start, end) =>
				resolveRangeFromParagraphs(instructionParagraphs, start, end),
		);
		expect(parsed).toBeTruthy();
		if (!parsed?.ast) return;

		const translated = translateInstructionAstToEditTree(parsed.ast);
		expect(translated).toBeTruthy();
		if (!translated?.tree) return;
		expect(translated.issues, sample.citation).toEqual([]);

		const effect = applyAmendmentEditTreeToSection({
			tree: translated.tree,
			sectionPath: sample.sectionPath,
			sectionBody: readFileSync(
				fixturePathFromSectionPath(sample.sectionPath),
				"utf8",
			).trim(),
			instructionText: instructionLines.join("\n"),
		});

		expect(effect.status, sample.citation).toBe("ok");
		expect(
			effect.debug.operationAttempts.length,
			sample.citation,
		).toBeGreaterThan(0);
		expect(
			effect.debug.operationAttempts.every(
				(attempt) => attempt.outcome === "applied",
			),
			sample.citation,
		).toBe(true);
		expect(effect.renderModel.plainText, sample.citation).toContain(
			sample.expectedEditedExcerpt,
		);
	});
}
