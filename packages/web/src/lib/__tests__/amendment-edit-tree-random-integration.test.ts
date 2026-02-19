import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const USC_2014_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014-pre.md",
);
const USC_2036A_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2036a-pre.md",
);
const USC_9011_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-9011-pre.md",
);

interface SelectedInstructionBlock {
	citation: string;
	sectionPath: string;
	instructionText: string;
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

const BASE_SECTION_FIXTURES: Readonly<Record<string, string>> = {
	"/statutes/usc/section/7/2014": readFileSync(
		USC_2014_PRE_FIXTURE_PATH,
		"utf8",
	),
	"/statutes/usc/section/7/2036a": readFileSync(
		USC_2036A_PRE_FIXTURE_PATH,
		"utf8",
	),
	"/statutes/usc/section/7/9011": readFileSync(
		USC_9011_PRE_FIXTURE_PATH,
		"utf8",
	),
};

const RANDOM_INTEGRATION_SECTION_FIXTURES: Readonly<Record<string, string>> = {
	"/statutes/usc/section/7/1308-2": `
(d) A person that is a member of partnerships and joint ventures shall be jointly and severally liable in an amount that is proportionate to the ownership share of the person in partnerships and joint ventures.
`.trim(),
	"/statutes/usc/section/7/1308-3a": `
(d) For purposes of this section, a corporation, general partnership, or joint venture shall include an entity that receives income directly.
Any reference to a corporation, general partnership, or joint venture in this subsection applies to substantially similar entities.
`.trim(),
	"/statutes/usc/section/7/9031": `
(b) NONRECOURSE MARKETING ASSISTANCE LOANS.
(1) The Secretary shall make available nonrecourse marketing assistance loans for the 2023 crop year.
`.trim(),
	"/statutes/usc/section/7/9035": `
(a) AVAILABILITY OF PAYMENTS.
(2) PAYMENTS.
(B) A payment under this paragraph shall be available for each crop year through 2023.
`.trim(),
	"/statutes/usc/section/7/9036": `
(a) The Secretary may make payments in lieu of loan deficiency payments through 2023.
(d) Any payment under this section for 2023 shall be made not later than 60 days after application.
`.trim(),
	"/statutes/usc/section/7/9037": `
(c) RATE.
(1) The value of the assistance under paragraph (1) shall be 3 cents per pound.
(2) The value of the assistance under paragraph (1) shall be 4 cents per pound.
`.trim(),
	"/statutes/usc/section/7/1359bb": `
(a) ESTIMATES.
(1) Not later than July 1, 2023, the Secretary shall publish estimates of sugar supply and use.
`.trim(),
	"/statutes/usc/section/7/1359ll": `
(a) PERIOD OF EFFECTIVENESS.
This section shall apply through 2023.
`.trim(),
	"/statutes/usc/section/7/9051": `
(8) PRODUCTION HISTORY.
The term "production history" means the production history established for a participating dairy operation when the participating dairy operation first registers to participate in dairy margin coverage.
`.trim(),
	"/statutes/usc/section/7/9056": `
(a) PAYMENTS.
(1) PAYMENTS TO DAIRY OPERATIONS.
(C) The production history of a participating dairy operation shall be equal to the lesser of 5,000,000 pounds and 95 percent of established production history.
For purposes of this subsection, 5,000,000 pounds shall be treated as the statutory cap.
`.trim(),
};

const SECTION_FIXTURES: Readonly<Record<string, string>> = {
	...BASE_SECTION_FIXTURES,
	...RANDOM_INTEGRATION_SECTION_FIXTURES,
};

const sectionBodyCache = new Map<string, string>();

async function loadSectionBody(sectionPath: string): Promise<string> {
	const cached = sectionBodyCache.get(sectionPath);
	if (cached) return cached;

	const body = SECTION_FIXTURES[sectionPath];
	if (!body) {
		throw new Error(`Missing section fixture for ${sectionPath}`);
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
});
