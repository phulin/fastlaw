import { describe, expect, it } from "vitest";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import type { Paragraph } from "../text-extract";

function createMockParagraph(
	text: string,
	xStart: number = 0,
	startPage: number = 1,
): Paragraph {
	return {
		text,
		lines: [
			{
				xStart,
				text,
				page: startPage,
				y: 100,
				yStart: 100,
				yEnd: 110,
				xEnd: xStart + 50,
				items: [],
				pageHeight: 800,
			} as any,
		],
		startPage,
		endPage: startPage,
		confidence: 1,
		y: 100,
		yStart: 100,
		yEnd: 110,
		pageHeight: 800,
	} as Paragraph;
}

describe("extractAmendatoryInstructions", () => {
	it("coalesces multi-level instructions when parent has 'is amended'", () => {
		const paras = [
			createMockParagraph("SEC. 101. SOMETHING.", 72),
			createMockParagraph("(a) IN GENERAL.—Section 123 is amended—", 90),
			createMockParagraph('(1) in subsection (a), by striking "foo"; and', 108),
			createMockParagraph("(2) in subsection (b)—", 108),
			createMockParagraph('(A) by striking "bar"; and', 126),
			createMockParagraph('(B) by inserting "baz".', 126),
		];

		const instructions = extractAmendatoryInstructions(paras);

		expect(instructions).toHaveLength(1);
		expect(instructions[0].target).toBe("Section 123");
		expect(instructions[0].billSection).toContain("SEC. 101");
		expect(instructions[0].text).toContain("(a) IN GENERAL");
		expect(instructions[0].text).toContain('(B) by inserting "baz"');
	});

	it("keeps siblings distinct when parent is just a header", () => {
		const paras = [
			createMockParagraph("SEC. 102. ANOTHER THING.", 72),
			createMockParagraph("(b) CONFORMING AMENDMENTS.—", 90), // No "is amended"
			createMockParagraph('(1) Section 456 is amended by striking "x".', 108),
			createMockParagraph("(2) Section 789 is repealed.", 108),
		];

		const instructions = extractAmendatoryInstructions(paras);

		expect(instructions).toHaveLength(2);
		expect(instructions[0].target).toBe("Section 456");
		expect(instructions[1].target).toBe("Section 789");
	});

	it("handles 'is further amended'", () => {
		const paras = [
			createMockParagraph("SEC. 104. FURTHER.", 72),
			createMockParagraph(
				"Section 123 of Something (1 U.S.C. 1) is further amended—",
				90,
			),
			createMockParagraph('(1) by striking "old".', 108),
		];
		const instructions = extractAmendatoryInstructions(paras);
		expect(instructions).toHaveLength(1);
		expect(instructions[0].target).toBe(
			"Section 123 of Something (1 U.S.C. 1)",
		);
	});

	it("handles the case with (A) and (i)", () => {
		const paras = [
			createMockParagraph(
				"(a) IN GENERAL.—Section 1115 of the Agricultural Act of 2014 (7 U.S.C. 9015) is amended—",
				90,
			),
			createMockParagraph(
				"(1) in subsection (a), in the matter preceding paragraph (1), by striking “2023” and inserting “2031”;",
				108,
			),
			createMockParagraph("(2) in subsection (c)—", 108),
			createMockParagraph("(A) in the matter preceding paragraph (1)—", 126),
			createMockParagraph(
				"(i) by striking “crop year or” and inserting “crop year,”; and",
				144,
			),
		];

		const instructions = extractAmendatoryInstructions(paras);
		expect(instructions).toHaveLength(1);
		const text = instructions[0].text;
		expect(text).toContain("(a) IN GENERAL");
		expect(text).toContain("(2) in subsection (c)");
		expect(text).toContain("(A) in the matter");
		expect(text).toContain("(i) by striking");
	});

	it("groups indented and dedented quoted text correctly based on hierarchy", () => {
		const paragraphs: Paragraph[] = [
			createMockParagraph("SEC. 10105. MATCHING FUNDS REQUIREMENTS.", 0),
			// (a) Subsection - Instruction Root
			createMockParagraph(
				"(a) IN GENERAL.—Section 4(a) of the Food and Nutrition Act of 2008 (7 U.S.C. 2013(a)) is amended—",
				20,
			),
			// (1) Paragraph - Child of (a)
			createMockParagraph(
				"(1) by striking “(a) Subject to” and inserting the following:",
				40,
			),

			// Quoted text - Dedented to 20 (same as (a)), but should be child of (1) or at least (a)
			createMockParagraph("“(a) PROGRAM.—", 20),
			createMockParagraph("“(1) ESTABLISHMENT.—Subject to”; and", 20),

			// (2) Paragraph - Sibling of (1), Child of (a)
			createMockParagraph("(2) by adding at the end the following:", 40),

			// Quoted text block
			createMockParagraph("“(2) STATE QUALITY CONTROL INCENTIVE.—", 20),
			createMockParagraph(
				"“(A) DEFINITION OF PAYMENT ERROR RATE.—In this paragraph, the term ‘payment error rate’ has the meaning given the term in section 16(c)(2).",
				20,
			),
			createMockParagraph("“(B) STATE COST SHARE.—", 20),
			createMockParagraph(
				"“(i) IN GENERAL.—Subject to clause (iii), beginning in fiscal year 2028, if the payment error rate of a State as determined under clause (ii) is—",
				20,
			),
			createMockParagraph(
				"“(I) less than 6 percent, the Federal share of the cost of the allotment described in paragraph (1) for that State in a fiscal year shall be 100 percent, and the State share shall be 0 percent;",
				20,
			),
			createMockParagraph(
				"“(II) equal to or greater than 6 percent but less than 8 percent, the Federal share of the cost of the allotment described in paragraph (1) for that State in a fiscal year shall be 95 percent, and the State share shall be 5 percent;",
				20,
			),
			createMockParagraph(
				"“(III) equal to or greater than 8 percent but less than 10 percent, the Federal share of the cost of the allotment described in paragraph (1) for that State in a fiscal year shall be 90 percent, and the State share shall be 10 percent; and",
				20,
			),
			createMockParagraph(
				"“(IV) equal to or greater than 10 percent, the Federal share of the cost of the allotment described in paragraph (1) for that State in a fiscal year shall be 85 percent, and the State share shall be 15 percent.",
				20,
			),
			createMockParagraph(
				"“(3) MAXIMUM FEDERAL PAYMENT.—The Secretary may not pay towards the cost of an allotment described in paragraph (1) an amount that is greater than the applicable Federal share under paragraph (2).”.",
				20,
			),

			// (b) Subsection - Sibling of (a). Should close the previous instruction.
			createMockParagraph(
				"(b) LIMITATION ON AUTHORITY.—Section 13(a)(1) of the Food and Nutrition Act of 2008 (7 U.S.C. 2022(a)(1)) is amended in the first sentence by inserting “or the payment or disposition of a State share under section 4(a)(2)” after “16(c)(1)(D)(i)(II)”.",
				20,
			),
		];

		const instructions = extractAmendatoryInstructions(paragraphs);

		expect(instructions).toHaveLength(2);

		const instr1 = instructions[0];
		expect(instr1.target.startsWith("Section 4(a)")).toBe(true);
		expect(instr1.text).toContain("“(a) PROGRAM.—");
		expect(instr1.text).toContain("“(2) STATE QUALITY CONTROL INCENTIVE.—");
		expect(instr1.text).toContain("MAXIMUM FEDERAL PAYMENT");
		// Should NOT contain (b) text
		expect(instr1.text).not.toContain("LIMITATION ON AUTHORITY");

		const instr2 = instructions[1];
		expect(instr2.target.startsWith("Section 13(a)(1)")).toBe(true);
	});
});
