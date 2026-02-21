import { expect, test } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";

interface SelectedInstructionBlock {
	citation: string;
	sectionPath: string;
	instructionText: string;
	body: string;
	expectedBody: string;
}

const SELECTED_INSTRUCTION_BLOCKS: SelectedInstructionBlock[] = [
	{
		citation: "7 U.S.C. 2012(u)",
		sectionPath: "/statutes/usc/section/7/2012",
		instructionText: `(a) IN GENERAL.—Section 3 of the Food and Nutrition Act of 2008 (7 U.S.C. 2012) is amended by striking subsection (u) and inserting the following:
“(u) THRIFTY FOOD PLAN.—
“(1) IN GENERAL.—The term ‘thrifty food plan’ means the diet..."`,
		body: `(u) Thrifty food plan
The term "thrifty food plan" means the diet required...`,
		expectedBody: `(u) THRIFTY FOOD PLAN.—
(1) IN GENERAL.—The term ‘thrifty food plan’ means the diet...`,
	},
	{
		citation: "7 U.S.C. 2015(o)(4)",
		sectionPath: "/statutes/usc/section/7/2015/o",
		instructionText: `(b) STANDARDIZING ENFORCEMENT.—Section 6(o)(4) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(o)(4)) is amended—
(1) in subparagraph (A), by striking clause (ii) and inserting the following:
“(ii) is in a noncontiguous State.”;
(2) by adding at the end the following:
“(C) DEFINITION.—”`,
		body: `(4) Waivers
(A) On request...
(i) has an unemployment...
(ii) does not have a sufficient number...`,
		expectedBody: `(4) Waivers
(A) On request...
(i) has an unemployment...
(ii) is in a noncontiguous State.
(C) DEFINITION.—`,
	},
	{
		citation: "7 U.S.C. 2015(f)",
		sectionPath: "/statutes/usc/section/7/2015/f",
		instructionText: `Section 6(f) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(f)) is amended to read as follows:
“(f) No individual who is a member of a household...”`,
		body: `(f) No individual who is a member... (old version)`,
		expectedBody: `(f) No individual who is a member of a household...`,
	},
	{
		citation: "7 U.S.C. 2015(o)",
		sectionPath: "/statutes/usc/section/7/2015/o",
		instructionText: `(c) WAIVER FOR NONCONTIGUOUS STATES.—Section 6(o) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(o)) is amended—
(1) by redesignating paragraph (7) as paragraph (8); and
(2) by inserting after paragraph (6) the following:
“(7) EXEMPTION.—”`,
		body: `(o) Work requirement
(6) 15-percent exemption...
(7) Other exemptions...`,
		expectedBody: `(o) Work requirement
(6) 15-percent exemption...
(7) EXEMPTION.—
(8) Other exemptions...`,
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
		body: `(a) Subject to the availability of funds...`,
		expectedBody: `(a) PROGRAM.—
(1) ESTABLISHMENT.—Subject to the availability of funds...
(2) STATE QUALITY CONTROL INCENTIVE.—`,
	},
	{
		citation: "7 U.S.C. 9011(8)(B)(ii)",
		sectionPath: "/statutes/usc/section/7/9011/8/B",
		instructionText: `Section 1111(8)(B)(ii) of the Agricultural Act of 2014 (7 U.S.C. 9011(8)(B)(ii)) is amended by striking “85” and inserting “beginning with the crop year 2025, 88”.`,
		body: `(ii) 85 percent of the average of the marketing year average price of the covered commodity...`,
		expectedBody: `(ii) beginning with the crop year 2025, 88 percent of the average of the marketing year average price of the covered commodity...`,
	},
	{
		citation: "7 U.S.C. 9015",
		sectionPath: "/statutes/usc/section/7/9015",
		instructionText: `Section 1115 of the Agricultural Act of 2014 (7 U.S.C. 9015) is amended—
(1) in subsection (a), in the matter preceding paragraph (1), by striking “2023” and inserting “2031”;`,
		body: `(a) Producer election
For the 2014 through 2023 crop years, all of the producers on a farm shall...`,
		expectedBody: `(a) Producer election
For the 2014 through 2031 crop years, all of the producers on a farm shall...`,
	},
	{
		citation: "7 U.S.C. 9034",
		sectionPath: "/statutes/usc/section/7/9034/b",
		instructionText: `Section 1204 of the Agricultural Act of 2014 (7 U.S.C. 9034) is amended—
(1) in subsection (b)—
(A) by redesignating paragraph (1) as subparagraph (A) and indenting appropriately;
(B) in the matter preceding subparagraph (A) (as so redesignated), by striking “The Secretary” and inserting the following:
“(1) IN GENERAL.—The Secretary"; 
(C) by striking paragraph (2) and inserting the following:
“(B)(i) in the case of long grain rice;
“(ii) in the case of upland cotton.
“(2) REFUND FOR UPLAND COTTON.—”`,
		body: `(b) Repayment
The Secretary shall permit producers to repay a marketing assistance loan at the lesser of—
(1) the loan rate;
(2) the prevailing world market price.`,
		expectedBody: `(b) Repayment
(1) IN GENERAL.—The Secretary shall permit producers to repay a marketing assistance loan at the lesser of—
(A) the loan rate;
(B)(i) in the case of long grain rice;
(ii) in the case of upland cotton.
(2) REFUND FOR UPLAND COTTON.—`,
	},
	{
		citation: "7 U.S.C. 2036(a)(2)",
		sectionPath: "/statutes/usc/section/7/2036/a",
		instructionText: `Section 27(a)(2) of the Food and Nutrition Act of 2008 (7 U.S.C. 2036(a)(2))) is amended by striking “section 3(u)(4)” each place it appears and inserting “section 3(u)(3)”.`,
		body: `(2) The amount allocated under section 3(u)(4) shall be equal to the amount determined under section 3(u)(4) of this Act.`,
		expectedBody: `(2) The amount allocated under section 3(u)(3) shall be equal to the amount determined under section 3(u)(3) of this Act.`,
	},
	{
		citation: "42 U.S.C. 1396o-1(a)(1)",
		sectionPath: "/statutes/usc/section/42/1396o-1/a",
		instructionText: `Section 1916A(a)(1) of the Social Security Act (42 U.S.C. 1396o–1(a)(1)) is amended, in the second sentence, by striking “or (j)” and inserting “(j), or (k)”.`,
		body: `(a) State option
(1) In general
Notwithstanding section 1396o of this title, a State may impose a premium. A state may also waive the rules of section (i) or (j) in certain conditions.`,
		expectedBody: `(a) State option
(1) In general
Notwithstanding section 1396o of this title, a State may impose a premium. A state may also waive the rules of section (i), (j), or (k) in certain conditions.`,
	},
	{
		citation: "7 U.S.C. 9038(a)",
		sectionPath: "/statutes/usc/section/7/9038/a",
		instructionText: `Section 1208(a) of the Agricultural Act of 2014 (7 U.S.C. 9038(a)) is amended, in the matter preceding paragraph (1), by striking “2026” and inserting “2032”.`,
		body: `(a) Competitiveness program
During the period beginning on the date of enactment of this Act and ending on July 31, 2026, the Secretary shall carry out a program—
(1) to aid in the competitiveness;`,
		expectedBody: `(a) Competitiveness program
During the period beginning on the date of enactment of this Act and ending on July 31, 2032, the Secretary shall carry out a program—
(1) to aid in the competitiveness;`,
	},
	{
		citation: "7 U.S.C. 1516(b)(2)(C)(i)",
		sectionPath: "/statutes/usc/section/7/1516/b/2/C",
		instructionText: `Section 516(b)(2)(C)(i) of the Federal Crop Insurance Act (7 U.S.C. 1516(b)(2)(C)(i)) is amended, in the matter preceding subclause (I), by striking “for each fiscal year” and inserting “for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter”.`,
		body: `(C) Research and development
(i) In general
There are authorized to be appropriated for each fiscal year:
(I) the amount of...`,
		expectedBody: `(C) Research and development
(i) In general
There are authorized to be appropriated for each of fiscal years 2014 through 2025 and $10,000,000 for fiscal year 2026 and each fiscal year thereafter:
(I) the amount of...`,
	},
	{
		citation: "26 U.S.C. 461(l)(1)",
		sectionPath: "/statutes/usc/section/26/461/l",
		instructionText: `Section 461(l)(1) is amended by striking “and before January 1, 2029,” each place it appears.`,
		body: `(l) Limitation on excess business losses of noncorporate taxpayers
(1) Limitation
In the case of a taxpayer other than a corporation and before January 1, 2029, any excess business loss and before January 1, 2029, shall be treated as a net operating loss.`,
		expectedBody: `(l) Limitation on excess business losses of noncorporate taxpayers
(1) Limitation
In the case of a taxpayer other than a corporation any excess business loss shall be treated as a net operating loss.`,
	},
	{
		citation: "7 U.S.C. 9036",
		sectionPath: "/statutes/usc/section/7/9036",
		instructionText: `Section 1206 of the Agricultural Act of 2014 (7 U.S.C. 9036) is amended, in subsections (a) and (d), by striking “2023” each place it appears and inserting “2031”.`,
		body: `(a) In general
For the 2014 through 2023 crop years, the Secretary may make payments...
(d) Application
This section applies to the 2014 through 2023 crop years.`,
		expectedBody: `(a) In general
For the 2014 through 2031 crop years, the Secretary may make payments...
(d) Application
This section applies to the 2014 through 2031 crop years.`,
	},
	{
		citation: "7 U.S.C. 1308-3a(d)",
		sectionPath: "/statutes/usc/section/7/1308-3a/d",
		instructionText: `Section 1001D(d) of the Food Security Act of 1985 (7 U.S.C. 1308–3a(d)) is amended by striking “, general partnership, or joint venture” each place it appears.`,
		body: `(d) Limitation
If a person, general partnership, or joint venture has an AGI exceeding $900,000, the person, general partnership, or joint venture shall be ineligible...`,
		expectedBody: `(d) Limitation
If a person has an AGI exceeding $900,000, the person shall be ineligible...`,
	},
];

for (const sample of SELECTED_INSTRUCTION_BLOCKS) {
	test(`HR1 Integration Diverse: ${sample.citation}`, () => {
		const parser = createHandcraftedInstructionParser();
		const parsed = parser.parseInstructionFromLines(
			sample.instructionText.split("\n"),
			0,
		);
		expect(parsed).toBeTruthy();
		if (!parsed?.ast) return;

		const translated = translateInstructionAstToEditTree(parsed.ast);
		expect(translated).toBeTruthy();
		if (!translated?.tree) return;

		const effect = applyAmendmentEditTreeToSection({
			tree: translated.tree,
			sectionPath: sample.sectionPath,
			sectionBody: sample.body,
			instructionText: sample.instructionText,
		});

		if (effect.status === "ok") {
			expect(effect.renderModel.plainText).toContain(sample.expectedBody);
		} else {
			expect(effect.status).not.toBe("unsupported");
		}
	});
}
