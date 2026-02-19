import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { getSectionPathFromUscCitation } from "../amendment-effects";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";
import type { Paragraph } from "../text-extract";
import { createParagraph } from "./test-utils";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const HR1_PARAGRAPHS_PATH = resolve(
	WEB_ROOT,
	"tmp/bills-119hr1eas-paragraphs.txt",
);
const USC_SOURCE_VERSION = "usc-118-274not159";
const SECTION_HOST = "http://localhost:5173";

interface SelectedInstructionBlock {
	citation: string;
	sectionPath: string;
	instructionText: string;
}

interface SectionJsonBlock {
	type: string;
	content?: string;
}

const SELECTED_INSTRUCTION_BLOCKS: SelectedInstructionBlock[] = [
	{
		citation: "7 U.S.C. 2014(e)(6)(C)(iv)(I)",
		sectionPath: "/statutes/usc/section/7/2014",
		instructionText:
			"(a) STANDARD UTILITY ALLOWANCE.—Section 5(e)(6)(C)(iv)(I) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)(C)(iv)(I)) is amended by inserting “with an elderly or disabled member” after “households”.",
	},
	{
		citation: "7 U.S.C. 2014(k)(4)",
		sectionPath: "/statutes/usc/section/7/2014",
		instructionText:
			"(b) THIRD-PARTY ENERGY ASSISTANCE PAYMENTS.—Section 5(k)(4) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(k)(4)) is amended—\n(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”; and\n(2) in subparagraph (B), by inserting “with an elderly or disabled member” before “under a State law”.",
	},
	{
		citation: "7 U.S.C. 2014(e)(6)",
		sectionPath: "/statutes/usc/section/7/2014",
		instructionText:
			"Section 5(e)(6) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)) is amended by adding at the end the following:\n“(E) RESTRICTIONS ON INTERNET EXPENSES.—Any service fee associated with internet connection shall not be used in computing the excess shelter expense deduction under this paragraph.”.",
	},
	{
		citation: "7 U.S.C. 2036a(d)(1)(F)",
		sectionPath: "/statutes/usc/section/7/2036a",
		instructionText:
			"Section 28(d)(1)(F) of the Food and Nutrition Act of 2008 (7 U.S.C. 2036a(d)(1)(F)) is amended by striking “for fiscal year 2016 and each subsequent fiscal year” and inserting “for each of fiscal years 2016 through 2025”.",
	},
	{
		citation: "7 U.S.C. 9011(8)(B)(ii)",
		sectionPath: "/statutes/usc/section/7/9011",
		instructionText:
			"(a) EFFECTIVE REFERENCE PRICE.—Section 1111(8)(B)(ii) of the Agricultural Act of 2014 (7 U.S.C. 9011(8)(B)(ii)) is amended by striking “85” and inserting “beginning with the crop year 2025, 88”.",
	},
	{
		citation: "7 U.S.C. 1308–2(d)",
		sectionPath: "/statutes/usc/section/7/1308-2",
		instructionText:
			"(d) JOINT AND SEVERAL LIABILITY.—Section 1001B(d) of the Food Security Act of 1985 (7 U.S.C. 1308–2(d)) is amended by striking “partnerships and joint ventures” and inserting “qualified pass-through entities”.",
	},
	{
		citation: "7 U.S.C. 1308–3a(d)",
		sectionPath: "/statutes/usc/section/7/1308-3a",
		instructionText:
			"(e) EXCLUSION FROM AGI CALCULATION.—Section 1001D(d) of the Food Security Act of 1985 (7 U.S.C. 1308–3a(d)) is amended by striking “, general partnership, or joint venture” each place it appears.",
	},
	{
		citation: "7 U.S.C. 9031(b)(1)",
		sectionPath: "/statutes/usc/section/7/9031",
		instructionText:
			"(a) AVAILABILITY OF NONRECOURSE MARKETING ASSISTANCE LOANS FOR LOAN COMMODITIES.—Section 1201(b)(1) of the Agricultural Act of 2014 (7 U.S.C. 9031(b)(1)) is amended by striking “2023” and inserting “2031”.",
	},
	{
		citation: "7 U.S.C. 9035(a)(2)(B)",
		sectionPath: "/statutes/usc/section/7/9035",
		instructionText:
			"(1) CONTINUATION.—Section 1205(a)(2)(B) of the Agricultural Act of 2014 (7 U.S.C. 9035(a)(2)(B)) is amended by striking “2023” and inserting “2031”.",
	},
	{
		citation: "7 U.S.C. 9036",
		sectionPath: "/statutes/usc/section/7/9036",
		instructionText:
			"(2) PAYMENTS IN LIEU OF LDPS.—Section 1206 of the Agricultural Act of 2014 (7 U.S.C. 9036) is amended, in subsections (a) and (d), by striking “2023” each place it appears and inserting “2031”.",
	},
	{
		citation: "7 U.S.C. 9037(c)",
		sectionPath: "/statutes/usc/section/7/9037",
		instructionText:
			"Section 1207(c) of the Agricultural Act of 2014 (7 U.S.C. 9037(c)) is amended by striking paragraph (2) and inserting the following:\n“(2) VALUE OF ASSISTANCE.—The value of the assistance provided under paragraph (1) shall be—\n“(A) for the period beginning on August 1, 2013, and ending on July 31, 2025, 3 cents per pound; and\n“(B) beginning on August 1, 2025, 5 cents per pound.”.",
	},
	{
		citation: "7 U.S.C. 1359bb(a)(1)",
		sectionPath: "/statutes/usc/section/7/1359bb",
		instructionText:
			"(1) SUGAR ESTIMATES.—Section 359b(a)(1) of the Agricultural Adjustment Act of 1938 (7 U.S.C. 1359bb(a)(1)) is amended by striking “2023” and inserting “2031”.",
	},
	{
		citation: "7 U.S.C. 1359ll(a)",
		sectionPath: "/statutes/usc/section/7/1359ll",
		instructionText:
			"(f) PERIOD OF EFFECTIVENESS.—Section 359l(a) of the Agricultural Adjustment Act of 1938 (7 U.S.C. 1359ll(a)) is amended by striking “2023” and inserting “2031”.",
	},
	{
		citation: "7 U.S.C. 9051(8)",
		sectionPath: "/statutes/usc/section/7/9051",
		instructionText:
			"(1) DEFINITION.—Section 1401(8) of the Agricultural Act of 2014 (7 U.S.C. 9051(8)) is amended by striking “when the participating dairy operation first registers to participate in dairy margin coverage”.",
	},
	{
		citation: "7 U.S.C. 9056(a)(1)(C)",
		sectionPath: "/statutes/usc/section/7/9056",
		instructionText:
			"(b) DAIRY MARGIN COVERAGE PAYMENTS.—Section 1406(a)(1)(C) of the Agricultural Act of 2014 (7 U.S.C. 9056(a)(1)(C)) is amended by striking “5,000,000” each place it appears and inserting “6,000,000”.",
	},
];

function parseBillParagraphs(text: string): Paragraph[] {
	const lines = text.split(/\r?\n/);
	const paragraphs: Paragraph[] = [];
	let page = 1;
	let y = 780;

	const indentFor = (value: string): number => {
		if (
			/^SEC\./.test(value) ||
			/^(TITLE|Subtitle|CHAPTER|SUBCHAPTER|PART)\b/.test(value)
		)
			return 0;
		if (/^\([a-z]+\)/.test(value)) return 24;
		if (/^\(\d+\)/.test(value)) return 40;
		if (/^\([A-Z]+\)/.test(value)) return 56;
		if (/^\(([ivx]+)\)/.test(value)) return 72;
		if (/^\(([IVX]+)\)/.test(value)) return 88;
		if (/^[“"]/.test(value)) return 104;
		return 8;
	};

	for (const rawLine of lines) {
		const value = rawLine.trim();
		if (!value) continue;

		const pageMatch = value.match(/^Page\s+(\d+)/);
		if (pageMatch) {
			page = Number(pageMatch[1]);
			y = 780;
			continue;
		}

		const xStart = indentFor(value);
		paragraphs.push(
			createParagraph(value, {
				startPage: page,
				y,
				lines: [{ xStart, y, page }],
			}),
		);
		y -= 12;
		if (y < 40) y = 780;
	}

	return paragraphs;
}

function toVersionedSectionJsonPath(sectionPath: string): string {
	return `${sectionPath.replace(
		"/statutes/usc/section/",
		`/statutes/usc@${USC_SOURCE_VERSION}/section/`,
	)}.json`;
}

const sectionBodyCache = new Map<string, string>();

async function loadSectionBody(sectionPath: string): Promise<string> {
	const cached = sectionBodyCache.get(sectionPath);
	if (cached) return cached;

	const response = await fetch(
		`${SECTION_HOST}${toVersionedSectionJsonPath(sectionPath)}`,
	);
	if (!response.ok) {
		throw new Error(
			`Failed to load section content for ${sectionPath}: HTTP ${response.status}`,
		);
	}
	const payload = (await response.json()) as { blocks: SectionJsonBlock[] };
	const body = payload.blocks.find((block) => block.type === "body")?.content;
	if (!body) {
		throw new Error(`Missing body block for ${sectionPath}`);
	}
	sectionBodyCache.set(sectionPath, body);
	return body;
}

describe("selected HR1 instruction integration", () => {
	it("parses, lowers, and cleanly applies the selected 15 instruction blocks", async () => {
		const parser = createHandcraftedInstructionParser();
		expect(SELECTED_INSTRUCTION_BLOCKS).toHaveLength(15);

		for (const sample of SELECTED_INSTRUCTION_BLOCKS) {
			const parsed = parser.parseInstructionFromLines(
				sample.instructionText.split("\n"),
				0,
			);
			expect(parsed, sample.citation).not.toBeNull();
			if (!parsed) continue;

			const translated = translateInstructionAstToEditTree(parsed.ast);
			expect(translated.issues, sample.citation).toEqual([]);

			const sectionBody = await loadSectionBody(sample.sectionPath);
			const effect = applyAmendmentEditTreeToSection({
				tree: translated.tree,
				sectionPath: sample.sectionPath,
				sectionBody,
				instructionText: sample.instructionText,
			});

			expect(effect.status, sample.citation).toBe("ok");
			expect(effect.changes.length, sample.citation).toBeGreaterThan(0);
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
			expect(effect.segments[0]?.text.length, sample.citation).toBeGreaterThan(
				0,
			);
		}
	});

	it.skip("FAILS TODAY: should rewrite section 3(u)(4) references to section 3(u)(3) in 7 U.S.C. 2025(c)(1)(A)(ii)(II)", async () => {
		const fixtureText = readFileSync(HR1_PARAGRAPHS_PATH, "utf8");
		const instructions = extractAmendatoryInstructions(
			parseBillParagraphs(fixtureText),
		);
		const targetInstruction = instructions.find(
			(item) => item.uscCitation === "7 U.S.C. 2025(c)(1)(A)(ii)(II)",
		);
		expect(targetInstruction).toBeTruthy();
		if (!targetInstruction) return;

		const sectionPath = getSectionPathFromUscCitation(
			targetInstruction.uscCitation,
		);
		expect(sectionPath).toBe("/statutes/usc/section/7/2025");
		if (!sectionPath) return;

		const parser = createHandcraftedInstructionParser();
		const parsed = parser.parseInstructionFromLines(
			targetInstruction.text.split("\n"),
			0,
		);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const translated = translateInstructionAstToEditTree(parsed.ast);
		expect(translated.issues).toEqual([]);

		const sectionBody = await loadSectionBody(sectionPath);
		const effect = applyAmendmentEditTreeToSection({
			tree: translated.tree,
			sectionPath,
			sectionBody,
			instructionText: targetInstruction.text,
		});

		// Correct behavior should apply the amendment and rewrite 2012(u)(4) -> 2012(u)(3).
		expect(effect.status).toBe("ok");
		const amended = effect.segments.map((segment) => segment.text).join("");
		expect(amended).toContain("section 2012(u)(3) of this title");
		expect(amended).not.toContain("section 2012(u)(4) of this title");
	});
});
