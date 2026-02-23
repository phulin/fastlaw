import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import type { FormattingSpan } from "../amendment-edit-engine-types";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";
import { type Paragraph, ParagraphRange } from "../types";
import { createParagraph, expectEffectToContainMarkedText } from "./test-utils";

interface SelectedInstructionBlock {
	citation: string;
	sectionPath: string;
	instructionText: string;
	instructionLineLevels: number[];
	expectedEditedExcerpt: string;
	expectedAbsentExcerpts?: string[];
	expectedMarkedEditSnippets?: string[];
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
	let foundStart = false;

	for (let i = 0; i < paragraphs.length; i += 1) {
		const paragraph = paragraphs[i];
		if (!paragraph) continue;
		const lineStart = cursor;
		const lineEnd = lineStart + paragraph.text.length;
		const isLastParagraph = i === paragraphs.length - 1;

		if (!foundStart) {
			if (start < lineEnd || (start === lineEnd && isLastParagraph)) {
				startIndex = i;
				startFirst = Math.max(
					0,
					Math.min(paragraph.text.length, start - lineStart),
				);
				foundStart = true;
			} else if (start === lineEnd && !isLastParagraph) {
				startIndex = i + 1;
				startFirst = 0;
				foundStart = true;
			}
		}
		if (end >= lineStart && end <= lineEnd) {
			endIndex = i;
			endLast = end - lineStart;
			break;
		}
		cursor = lineEnd + (isLastParagraph ? 0 : 1);
	}

	return new ParagraphRange(
		paragraphs.slice(startIndex, endIndex + 1),
		startFirst,
		endLast,
	);
};

const isWordChar = (char: string | undefined): boolean =>
	typeof char === "string" && /^[A-Za-z0-9]$/.test(char);

const sliceWithMarker = (text: string, offset: number, radius = 36): string => {
	const start = Math.max(0, offset - radius);
	const end = Math.min(text.length, offset + radius);
	const head = text.slice(start, offset);
	const tail = text.slice(offset, end);
	return `${head}<<<${tail}`;
};

const paragraphSpans = (spans: FormattingSpan[]): FormattingSpan[] =>
	spans
		.filter((span) => span.type === "paragraph")
		.sort((left, right) => left.start - right.start || left.end - right.end);

const textWithDeletedSpansRemoved = (
	plainText: string,
	spans: FormattingSpan[],
): string => {
	const deletionSpans = spans
		.filter((span) => span.type === "deletion")
		.map((span) => ({
			start: Math.max(0, Math.min(plainText.length, span.start)),
			end: Math.max(0, Math.min(plainText.length, span.end)),
		}))
		.filter((span) => span.end > span.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);

	if (deletionSpans.length === 0) return plainText;

	const mergedSpans: Array<{ start: number; end: number }> = [];
	for (const span of deletionSpans) {
		const previous = mergedSpans[mergedSpans.length - 1];
		if (!previous || span.start > previous.end) {
			mergedSpans.push(span);
			continue;
		}
		previous.end = Math.max(previous.end, span.end);
	}

	let cursor = 0;
	let result = "";
	for (const span of mergedSpans) {
		result += plainText.slice(cursor, span.start);
		cursor = span.end;
	}
	result += plainText.slice(cursor);
	return result;
};

const assertParagraphSpanOffsets = (
	plainText: string,
	spans: FormattingSpan[],
	citation: string,
): void => {
	const paragraphs = paragraphSpans(spans);
	expect(
		paragraphs.length,
		`${citation}: missing paragraph spans`,
	).toBeGreaterThan(0);

	for (const [index, span] of paragraphs.entries()) {
		expect(
			span.start,
			`${citation}: paragraph ${index} start out of bounds`,
		).toBeGreaterThanOrEqual(0);
		expect(
			span.end,
			`${citation}: paragraph ${index} end out of bounds`,
		).toBeLessThanOrEqual(plainText.length);
		expect(
			span.end,
			`${citation}: paragraph ${index} has empty/negative range`,
		).toBeGreaterThan(span.start);
	}

	for (let index = 1; index < paragraphs.length; index += 1) {
		const previous = paragraphs[index - 1];
		const current = paragraphs[index];
		if (!previous || !current) continue;

		expect(
			current.start,
			`${citation}: paragraph ${index - 1} overlaps paragraph ${index}`,
		).toBeGreaterThanOrEqual(previous.end);

		if (current.start === previous.end) {
			const previousLast = plainText[previous.end - 1];
			const currentFirst = plainText[current.start];
			expect(
				isWordChar(previousLast) && isWordChar(currentFirst),
				`${citation}: paragraph boundary splits token at ${current.start}; previous=[${previous.start},${previous.end}) "${plainText.slice(previous.start, Math.min(previous.end, previous.start + 120))}"; current=[${current.start},${current.end}) "${plainText.slice(current.start, Math.min(current.end, current.start + 120))}"; context="${sliceWithMarker(
					plainText,
					current.start,
				)}"`,
			).toBe(false);
		}
	}
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
		expectedEditedExcerpt: `(a) PROGRAM.—
(1) ESTABLISHMENT.—Subject to the availability of funds appropriated under section 2027 of this title, the Secretary is authorized to formulate and administer a supplemental nutrition assistance program under which, at the request of the State agency, eligible households within the State shall be provided an opportunity to obtain a more nutritious diet through the issuance to them of an allotment, except that a State may not participate in the supplemental nutrition assistance program if the Secretary determines that State or local sales taxes are collected within that State on purchases of food made with benefits issued under this chapter. The benefits so received by such households shall be used only to purchase food from retail food stores which have been approved for participation in the supplemental nutrition assistance program. Benefits issued and used as provided in this chapter shall be redeemable at face value by the Secretary through the facilities of the Treasury of the United States.
(2) STATE QUALITY CONTROL INCENTIVE.—`,
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
		expectedMarkedEditSnippets: [
			"for the 2019 through ~~2023~~++2031++ crop years",
		],
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
		expectedEditedExcerpt: `(b) Repayment rates for upland cotton, long grain rice, and medium grain rice
(1) IN GENERAL.—The Secretary shall permit producers to repay a marketing assistance loan under section 9031 of this title for upland cotton, long grain rice, and medium grain rice at a rate that is the lesser of—
(A) the loan rate established for the commodity under section 9032 of this title, plus interest (determined in accordance with section 7283 of this title); or
(B) (i) in the case of long grain rice and medium grain rice, the prevailing world market price for the commodity, as determined and adjusted by the Secretary in accordance with this section; or
(ii) in the case of upland cotton, the prevailing world market price for the commodity, as determined and adjusted by the Secretary in accordance with this section.
(2) REFUND FOR UPLAND COTTON.—`,
		expectedMarkedEditSnippets: [
			"~~The Secretary~~++(1) IN GENERAL.—The Secretary++",
		],
	},
	{
		citation: "7 U.S.C. 2036(a)(2)",
		sectionPath: "/statutes/usc/section/7/2036/a",
		instructionText: `(3) Section 27(a)(2) of the Food and Nutrition Act of 2008 (7 U.S.C. 2036(a)(2))) is amended by striking “section 3(u)(4)” each place it appears and inserting “section 3(u)(3)”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: "section 2012(u)(3)",
	},
	{
		citation: "42 U.S.C. 1396o-1(a)(1)",
		sectionPath: "/statutes/usc/section/42/1396o-1/a",
		instructionText: `(2) NONAPPLICABILITY OF ALTERNATIVE COST SHARING.—Section 1916A(a)(1) of the Social Security Act (42 U.S.C. 1396o–1(a)(1)) is amended, in the second sentence, by striking “or (j)” and inserting “(j), or (k)”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: `(1) In general
Notwithstanding sections 1396o and 1396a(a)(10)(B) of this title, but subject to paragraph (2), a State, at its option and through a State plan amendment, may impose premiums and cost sharing for any group of individuals (as specified by the State) and for any type of services (other than drugs for which cost sharing may be imposed under subsection (c) and non-emergency services furnished in a hospital emergency department for which cost sharing may be imposed under subsection (e)), and may vary such premiums and cost sharing among such groups or types, consistent with the limitations established under this section. Nothing in this section shall be construed as superseding (or preventing the application of) subsection (g), (i), (j), or (k) of section 1396o of this title.`,
		expectedMarkedEditSnippets: ["~~or (j)~~++(j), or (k)++"],
	},
	{
		citation: "47 U.S.C. 309(j)(11)",
		sectionPath: "/statutes/usc/section/47/309/j/11",
		instructionText: `(1) AMENDMENT.—Section 309(j)(11) of the Communications Act of 1934 (47 U.S.C. 309(j)(11)) is amended by striking “grant a license or permit under this subsection shall expire March 9, 2023” and all that follows and inserting the following: “complete a system of competitive bidding under this subsection shall expire September 30, 2034, except that, with respect to the electromagnetic spectrum— ”
“(A) between the frequencies of 3.1 gigahertz and 3.45 gigahertz, such authority shall not apply; and
“(B) between the frequencies of 7.4 gigahertz and 8.4 gigahertz, such authority shall not apply.”.`,
		instructionLineLevels: [1, 2, 2],
		expectedEditedExcerpt: `The authority of the Commission to complete a system of competitive bidding under this subsection shall expire September 30, 2034, except that, with respect to the electromagnetic spectrum—
(A) between the frequencies of 3.1 gigahertz and 3.45 gigahertz, such authority shall not apply; and
(B) between the frequencies of 7.4 gigahertz and 8.4 gigahertz, such authority shall not apply.`,
		expectedAbsentExcerpts: [
			"such authority shall expire on September 30, 2025",
			"such authority shall expire on the date that is 7 years after November 15, 2021",
		],
	},
	{
		citation: "7 U.S.C. 9038(a)",
		sectionPath: "/statutes/usc/section/7/9038/a",
		instructionText: `(e) SPECIAL COMPETITIVE PROVISIONS FOR EXTRA LONG STAPLE COTTON.—Section 1208(a) of the Agricultural Act of 2014 (7 U.S.C. 9038(a)) is amended, in the matter preceding paragraph (1), by striking “2026” and inserting “2032”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: `(a) Competitiveness program
Notwithstanding any other provision of law, during the period beginning on February 7, 2014, through July 31, 2032, the Secretary shall carry out a program—
(1) to maintain and expand the domestic use of extra long staple cotton produced in the United States;
(2) to increase exports of extra long staple cotton produced in the United States; and
(3) to ensure that extra long staple cotton produced in the United States remains competitive in world markets.`,
		expectedMarkedEditSnippets: ["~~2026~~++2032++"],
	},
	{
		citation: "7 U.S.C. 1516(b)(2)(C)(i)",
		sectionPath: "/statutes/usc/section/7/1516/b/2/C",
		instructionText: `Section 516(b)(2)(C)(i) of the Federal Crop Insurance Act (7 U.S.C. 1516(b)(2)(C)(i)) is amended, in the matter preceding subclause (I), by striking “for each fiscal year” and inserting “for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt: `(C) Reviews, compliance, and integrity
(i) In general
For each of the 2014 and subsequent reinsurance years, the Corporation may use the insurance fund established under subsection (c), but not to exceed $7,000,000 for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter, to pay costs—
(I) to reimburse expenses incurred for the operations and review of policies, plans of insurance, and related materials (including actuarial and related information); and
(II) to assist the Corporation in maintaining program actuarial soundness and financial integrity.`,
		expectedMarkedEditSnippets: [
			"~~for each fiscal year~~++for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter++",
		],
	},
	{
		citation: "7 U.S.C. 9036",
		sectionPath: "/statutes/usc/section/7/9036",
		instructionText: `(2) PAYMENTS IN LIEU OF LDPS.—Section 1206 of the Agricultural Act of 2014 (7 U.S.C. 9036) is amended, in subsections (a) and (d), by striking “2023” each place it appears and inserting “2031”.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"Effective for each of the 2014 through 2031 crop years",
		expectedMarkedEditSnippets: [
			"Effective for each of the 2014 through ~~2023~~++2031++ crop years",
		],
	},
	{
		citation: "7 U.S.C. 2025(a)",
		sectionPath: "/statutes/usc/section/7/2025",
		instructionText:
			"Section 16(a) of the Food and Nutrition Act of 2008 (7 U.S.C. 2025(a)) is amended in the matter preceding paragraph (1) by striking “agency an amount equal to 50 per centum” and inserting “agency, through fiscal year 2026, 50 percent, and for fiscal year 2027 and each fiscal year thereafter, 25 percent,”.",
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"agency, through fiscal year 2026, 50 percent, and for fiscal year 2027 and each fiscal year thereafter, 25 percent, of all administrative costs involved",
		expectedMarkedEditSnippets: [
			"~~agency an amount equal to 50 per centum~~++agency, through fiscal year 2026, 50 percent, and for fiscal year 2027 and each fiscal year thereafter, 25 percent,++ of all administrative costs involved",
		],
	},
	{
		citation: "7 U.S.C. 1308-3a(d)",
		sectionPath: "/statutes/usc/section/7/1308-3a/d",
		instructionText: `(e) EXCLUSION FROM AGI CALCULATION.—Section 1001D(d) of the Food Security Act of 1985 (7 U.S.C. 1308–3a(d)) is amended by striking “, general partnership, or joint venture” each place it appears.`,
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"to an entity, the amount of the payment or benefit shall be reduced",
		expectedMarkedEditSnippets: [
			"to an entity~~, general partnership, or joint venture~~, the amount of the payment or benefit shall be reduced",
		],
	},
	{
		citation: "26 U.S.C. 45(b)(11)(B)",
		sectionPath: "/statutes/usc/section/26/45",
		instructionText: `(1) IN GENERAL.—Section 45(b)(11) of the Internal Revenue Code of 1986 is amended—
(A) in subparagraph (B)—
(i) in clause (ii)(II), by striking “or” at the end,
(ii) in clause (iii)(II), by striking the period at the end and inserting “, or”, and
(iii) by adding at the end the following new clause:
“(iv) for purposes of any qualified facility which is an advanced nuclear facility, a metropolitan statistical area which has (or, at any time during the period beginning after December 31, 2009, had) 0.17 percent or greater direct employment related to the advancement of nuclear power, including employment related to—
“(I) an advanced nuclear facility,
“(II) advanced nuclear power research and development,
“(III) nuclear fuel cycle research, development, or production, including mining, enrichment, manufacture, storage, disposal, or recycling of nuclear fuel, and
“(IV) the manufacturing or assembly of components used in an advanced nuclear facility.”.`,
		instructionLineLevels: [1, 2, 3, 3, 3, 4, 5, 5, 5, 5],
		expectedEditedExcerpt:
			"(iv) for purposes of any qualified facility which is an advanced nuclear facility, a metropolitan statistical area which has (or, at any time during the period beginning after December 31, 2009, had) 0.17 percent or greater direct employment related to the advancement of nuclear power, including employment related to—",
		expectedMarkedEditSnippets: [
			"(II) has an unemployment rate at or above the national average unemployment rate for the previous year (as determined by the Secretary), ~~or~~",
			"(II) which is directly adjoining to any census tract described in subclause (I)~~.~~++, or++",
		],
	},
	{
		citation: "30 U.S.C. 207(a)",
		sectionPath: "/statutes/usc/section/30/207",
		instructionText:
			"(a) RATE.—Section 7(a) of the Mineral Leasing Act (30 U.S.C. 207(a)) is amended, in the fourth sentence, by striking “12½ per centum” and inserting “12½ percent, except such amount shall be not more than 7 percent during the period that begins on the date of enactment of the Act entitled ‘An Act to provide for reconciliation pursuant to title II of H. Con. Res. 14’ (119th Congress) and ends September 30, 2034,”.",
		instructionLineLevels: [1],
		expectedEditedExcerpt:
			"12½ percent, except such amount shall be not more than 7 percent during the period that begins on the date of enactment of the Act entitled ‘An Act to provide for reconciliation pursuant to title II of H. Con. Res. 14’ (119th Congress) and ends September 30, 2034,",
		expectedMarkedEditSnippets: [
			"A coal lease shall be for a term of twenty years and for so long thereafter as coal is produced annually in commercial quantities from that lease. Any lease which is not producing in commercial quantities at the end of ten years shall be terminated. The Secretary shall by regulation prescribe annual rentals on leases. A lease shall require payment of a royalty in such amount as the Secretary shall determine of not less than ~~12½ per centum~~++12½ percent, except such amount shall be not more than 7 percent during the period that begins on the date of enactment of the Act entitled ‘An Act to provide for reconciliation pursuant to title II of H. Con. Res. 14’ (119th Congress) and ends September 30, 2034,++",
		],
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

		assertParagraphSpanOffsets(
			effect.renderModel.plainText,
			effect.renderModel.spans,
			sample.citation,
		);

		if (sample.expectedMarkedEditSnippets) {
			for (const markedSnippet of sample.expectedMarkedEditSnippets) {
				expectEffectToContainMarkedText(effect, markedSnippet);
			}
		}

		const editedTextWithoutDeletions = textWithDeletedSpansRemoved(
			effect.renderModel.plainText,
			effect.renderModel.spans,
		);
		expect(editedTextWithoutDeletions, sample.citation).toContain(
			sample.expectedEditedExcerpt,
		);
	});
}
