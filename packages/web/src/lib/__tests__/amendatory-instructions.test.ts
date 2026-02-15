import { describe, expect, it } from "vitest";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import type { Paragraph } from "../text-extract";
import { createParagraph } from "./test-utils";

describe("extractAmendatoryInstructions", () => {
	it("coalesces multi-level instructions when parent has 'is amended'", () => {
		const paras = [
			createParagraph("SEC. 101. SOMETHING.", {
				lines: [{ xStart: 72 }],
			}),
			createParagraph("(a) IN GENERAL.—Section 123 is amended—", {
				lines: [{ xStart: 90 }],
			}),
			createParagraph('(1) in subsection (a), by striking "foo"; and', {
				lines: [{ xStart: 108 }],
			}),
			createParagraph("(2) in subsection (b)—", {
				lines: [{ xStart: 108 }],
			}),
			createParagraph('(A) by striking "bar"; and', {
				lines: [{ xStart: 126 }],
			}),
			createParagraph('(B) by inserting "baz".', {
				lines: [{ xStart: 126 }],
			}),
		];

		const instructions = extractAmendatoryInstructions(paras);

		expect(instructions).toHaveLength(1);

		// Verify structured parsing
		expect(instructions[0].rootQuery).toEqual([
			{ type: "section", val: "123" },
		]);

		const tree = instructions[0].tree;
		// (a) is the root node in the tree
		expect(tree[0].label).toEqual({ type: "subsection", val: "a" });
		const children = tree[0].children;

		// (1)
		expect(children[0].label).toEqual({ type: "paragraph", val: "1" });
		expect(children[0].operation.type).toBe("delete"); // contains "striking"
		expect(children[0].operation.target).toEqual([
			{ type: "subsection", val: "a" },
		]);

		// (2)
		expect(children[1].label).toEqual({ type: "paragraph", val: "2" });
		expect(children[1].operation.type).toBe("context"); // "in subsection (b)—"
		expect(children[1].children).toHaveLength(2);

		// (A)
		expect(children[1].children[0].label).toEqual({
			type: "subparagraph",
			val: "A",
		});
		expect(children[1].children[0].operation.type).toBe("delete");

		// (B)
		expect(children[1].children[1].label).toEqual({
			type: "subparagraph",
			val: "B",
		});
		expect(children[1].children[1].operation.type).toBe("insert");
	});

	it("keeps siblings distinct when parent is just a header", () => {
		const paras = [
			createParagraph("SEC. 102. ANOTHER THING.", {
				lines: [{ xStart: 72 }],
			}),
			createParagraph("(b) CONFORMING AMENDMENTS.—", {
				lines: [{ xStart: 90 }],
			}), // No "is amended"
			createParagraph('(1) Section 456 is amended by striking "x".', {
				lines: [{ xStart: 108 }],
			}),
			createParagraph("(2) Section 789 is repealed.", {
				lines: [{ xStart: 108 }],
			}),
		];

		const instructions = extractAmendatoryInstructions(paras);

		expect(instructions).toHaveLength(2);
		expect(instructions[0].target).toBe("Section 456");
		expect(instructions[1].target).toBe("Section 789");

		expect(instructions[0].rootQuery).toEqual([
			{ type: "section", val: "456" },
		]);
		expect(instructions[1].rootQuery).toEqual([
			{ type: "section", val: "789" },
		]);
	});

	it("handles 'is further amended'", () => {
		const paras = [
			createParagraph("SEC. 104. FURTHER.", { lines: [{ xStart: 72 }] }),
			createParagraph(
				"Section 123 of Something (1 U.S.C. 1) is further amended—",
				{ lines: [{ xStart: 90 }] },
			),
			createParagraph('(1) by striking "old".', {
				lines: [{ xStart: 108 }],
			}),
		];
		const instructions = extractAmendatoryInstructions(paras);
		expect(instructions).toHaveLength(1);
		expect(instructions[0].target).toBe(
			"Section 123 of Something (1 U.S.C. 1)",
		);
		expect(instructions[0].rootQuery[0]).toEqual({
			type: "section",
			val: "123",
		});
	});

	it("handles the case with (A) and (i)", () => {
		const paras = [
			createParagraph(
				"(a) IN GENERAL.—Section 1115 of the Agricultural Act of 2014 (7 U.S.C. 9015) is amended—",
				{ lines: [{ xStart: 90 }] },
			),
			createParagraph(
				"(1) in subsection (a), in the matter preceding paragraph (1), by striking “2023” and inserting “2031”;",
				{ lines: [{ xStart: 108 }] },
			),
			createParagraph("(2) in subsection (c)—", {
				lines: [{ xStart: 108 }],
			}),
			createParagraph("(A) in the matter preceding paragraph (1)—", {
				lines: [{ xStart: 126 }],
			}),
			createParagraph(
				"(i) by striking “crop year or” and inserting “crop year,”; and",
				{ lines: [{ xStart: 144 }] },
			),
		];

		const instructions = extractAmendatoryInstructions(paras);
		expect(instructions).toHaveLength(1);

		// Verify deep structure
		const tree = instructions[0].tree;
		expect(tree[0].label).toEqual({ type: "subsection", val: "a" });
		const children = tree[0].children;

		expect(children[0].label).toEqual({ type: "paragraph", val: "1" });
		expect(children[0].operation.type).toBe("replace"); // striking and inserting

		expect(children[1].label).toEqual({ type: "paragraph", val: "2" });
		expect(children[1].operation.type).toBe("context");
		expect(children[1].children[0].label).toEqual({
			type: "subparagraph",
			val: "A",
		});
		expect(children[1].children[0].children[0].label).toEqual({
			type: "clause",
			val: "i",
		});
	});

	it("groups indented and dedented quoted text correctly based on hierarchy", () => {
		const paragraphs: Paragraph[] = [
			createParagraph("SEC. 10105. MATCHING FUNDS REQUIREMENTS.", {
				lines: [{ xStart: 0 }],
			}),
			// (a) Subsection - Instruction Root
			createParagraph(
				"(a) IN GENERAL.—Section 4(a) of the Food and Nutrition Act of 2008 (7 U.S.C. 2013(a)) is amended—",
				{ lines: [{ xStart: 20 }] },
			),
			// (1) Paragraph - Child of (a)
			createParagraph(
				"(1) by striking “(a) Subject to” and inserting the following:",
				{ lines: [{ xStart: 40 }] },
			),
			// Quoted text
			createParagraph("“(a) PROGRAM.—", { lines: [{ xStart: 20 }] }),
			createParagraph("“(1) ESTABLISHMENT.—Subject to”; and", {
				lines: [{ xStart: 20 }],
			}),

			// (2) Paragraph - Sibling of (1), Child of (a)
			createParagraph("(2) by adding at the end the following:", {
				lines: [{ xStart: 40 }],
			}),

			// Quoted text block
			createParagraph("“(2) STATE QUALITY CONTROL INCENTIVE.—", {
				lines: [{ xStart: 20 }],
			}),
			createParagraph("“(3) MAXIMUM FEDERAL PAYMENT.—...", {
				lines: [{ xStart: 20 }],
			}),

			// (b) Subsection - Sibling of (a). Should close the previous instruction.
			createParagraph(
				"(b) LIMITATION ON AUTHORITY.—Section 13(a)(1) ... is amended ...",
				{ lines: [{ xStart: 20 }] },
			),
		];

		const instructions = extractAmendatoryInstructions(paragraphs);

		expect(instructions).toHaveLength(2);

		const instr1 = instructions[0];
		expect(instr1.rootQuery).toEqual([
			{ type: "section", val: "4" },
			{ type: "subsection", val: "a" },
		]);

		const tree = instr1.tree;
		expect(tree[0].label?.type).toBe("subsection"); // (a)
		const children = tree[0].children;

		expect(children[0].label?.type).toBe("paragraph"); // (1)
		expect(children[0].operation.type).toBe("replace");
		// Verify children are captured (quoted text)
		expect(children[0].children.length).toBeGreaterThan(0);
		expect(children[0].children[0].operation.type).toBe("unknown"); // Quoted text

		expect(children[1].label?.type).toBe("paragraph"); // (2)
		expect(children[1].operation.type).toBe("add_at_end");
	});

	it("parses test cases from hr1-abridged-output.txt", () => {
		// Instruction 1: Section 3 (Page 13)
		const para1 = createParagraph(
			"(a) IN GENERAL.—Section 3 of the Food and Nutrition Act of 2008 (7 U.S.C. 2012) is amended by striking subsection (u) and inserting the following:",
			{ startPage: 13, lines: [{ xStart: 20 }] },
		);
		const instrs1 = extractAmendatoryInstructions([para1]);
		expect(instrs1[0].rootQuery).toEqual([{ type: "section", val: "3" }]);
		expect(instrs1[0].tree[0].operation.type).toBe("replace");

		// Instruction 2: Section 16(c)(1)(A)(ii)(II) (Page 16)
		const para2 = createParagraph(
			"(1) Section 16(c)(1)(A)(ii)(II) of the Food and Nutrition Act of 2008 (7 U.S.C. 2025(c)(1)(A)(ii)(II)) is amended by striking “section 3(u)(4)” and inserting “section 3(u)(3)”.",
			{ startPage: 16, lines: [{ xStart: 40 }] },
		);
		const instrs2 = extractAmendatoryInstructions([para2]);
		expect(instrs2[0].rootQuery).toEqual([
			{ type: "section", val: "16" },
			{ type: "subsection", val: "c" },
			{ type: "paragraph", val: "1" },
			{ type: "subparagraph", val: "A" },
			{ type: "clause", val: "ii" },
			{ type: "subclause", val: "II" },
		]);
		expect(instrs2[0].tree[0].operation.type).toBe("replace");

		// Instruction 8: Section 5(e)(6)(C)(iv)(I) (Page 21) - Testing "after"
		const para8 = createParagraph(
			"(a) STANDARD UTILITY ALLOWANCE.—Section 5(e)(6)(C)(iv)(I) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)(C)(iv)(I)) is amended by inserting “with an elderly or disabled member” after “households”.",
			{ startPage: 21, lines: [{ xStart: 20 }] },
		);
		const instrs8 = extractAmendatoryInstructions([para8]);
		expect(instrs8[0].tree[0].operation.type).toBe("insert_after");

		// Instruction 9: Section 5(k)(4) (Page 21) - Testing "before"
		const paras9 = [
			createParagraph(
				"(b) THIRD-PARTY ENERGY ASSISTANCE PAYMENTS.— Section 5(k)(4) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(k)(4)) is amended—",
				{ startPage: 21, lines: [{ xStart: 20 }] },
			),
			createParagraph(
				"(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”; and",
				{ startPage: 21, lines: [{ xStart: 40 }] },
			),
		];
		const instrs9 = extractAmendatoryInstructions(paras9);
		const tree9 = instrs9[0].tree;
		expect(tree9[0].children[0].operation.type).toBe("insert_before");
		expect(tree9[0].children[0].operation.target).toEqual([
			{ type: "subparagraph", val: "A" },
		]);

		// Instruction 7: Section 6(o) (Page 18) - Testing insert after paragraph
		const paras7 = [
			createParagraph(
				"(c) WAIVER FOR NONCONTIGUOUS STATES.—Section 6(o) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(o)) is amended—",
				{ startPage: 18, lines: [{ xStart: 20 }] },
			),
			createParagraph(
				"(1) by redesignating paragraph (7) as paragraph (8); and",
				{ startPage: 18, lines: [{ xStart: 40 }] },
			),
			createParagraph("(2) by inserting after paragraph (6) the following:", {
				startPage: 18,
				lines: [{ xStart: 40 }],
			}),
		];
		const instrs7 = extractAmendatoryInstructions(paras7);
		const tree7 = instrs7[0].tree;
		expect(tree7[0].children[1].operation.type).toBe("insert_after");
		expect(tree7[0].children[1].operation.target).toEqual([
			{ type: "paragraph", val: "6" },
		]);
	});

	it("parses target string correctly", () => {
		const paras = [
			createParagraph("SEC. 101. TEST.", { lines: [{ xStart: 0 }] }),
			createParagraph("Section 3(u)(4) of the Act is amended...", {
				lines: [{ xStart: 0 }],
			}),
		];
		const instructions = extractAmendatoryInstructions(paras);
		expect(instructions[0].rootQuery).toEqual([
			{ type: "section", val: "3" },
			{ type: "subsection", val: "u" },
			{ type: "paragraph", val: "4" },
		]);
	});

	it("captures strikingContent and content from quoted text", () => {
		const para = createParagraph(
			"(1) by striking “section 3(u)(4)” and inserting “section 3(u)(3)”.",
			{ lines: [{ xStart: 40 }] },
		);
		// Wrap in a mock instruction context
		const instructionLine = createParagraph("Section 16 is amended—", {
			lines: [{ xStart: 20 }],
		});
		const instructions = extractAmendatoryInstructions([instructionLine, para]);

		const op = instructions[0].tree[0].children[0].operation;
		expect(op.type).toBe("replace");
		expect(op.strikingContent).toBe("section 3(u)(4)");
		expect(op.content).toBe("section 3(u)(3)");
	});

	it("parses title-based United States Code citation and subsection target order", () => {
		const paragraphs = [
			createParagraph(
				"SEC. 211. MODIFICATION TO AUTHORITY TO AWARD PRIZES FOR ADVANCED TECHNOLOGY ACHIEVEMENTS.",
				{ startPage: 101, lines: [{ xStart: 0 }] },
			),
			createParagraph(
				"(a) AUTHORITY.—Subsection (a) of section 4025 of title 10, United States Code, is amended by inserting after “the Under Secretary of Defense for Acquisition and Sustainment,” the following: “the Director of the Defense Innovation Unit,”.",
				{ startPage: 101, lines: [{ xStart: 20 }] },
			),
		];
		const instructions = extractAmendatoryInstructions(paragraphs);
		expect(instructions).toHaveLength(1);

		const instruction = instructions[0];
		expect(instruction.uscCitation).toBe("10 U.S.C. 4025");
		expect(instruction.rootQuery).toEqual([
			{ type: "section", val: "4025" },
			{ type: "subsection", val: "a" },
		]);
		expect(instruction.tree[0].operation.type).toBe("insert_after");
		expect(instruction.tree[0].operation.target).toEqual([
			{ type: "section", val: "4025" },
			{ type: "subsection", val: "a" },
		]);
		expect(instruction.tree[0].operation.content).toBe(
			"the Director of the Defense Innovation Unit,",
		);
	});

	it("resolves 'such section' for subsection prize updates and parses replace operations", () => {
		const paragraphs = [
			createParagraph(
				"SEC. 211. MODIFICATION TO AUTHORITY TO AWARD PRIZES FOR ADVANCED TECHNOLOGY ACHIEVEMENTS.",
				{ startPage: 101, lines: [{ xStart: 0 }] },
			),
			createParagraph(
				"(a) AUTHORITY.—Subsection (a) of section 4025 of title 10, United States Code, is amended by inserting after “the Under Secretary of Defense for Acquisition and Sustainment,” the following: “the Director of the Defense Innovation Unit,”.",
				{ startPage: 101, lines: [{ xStart: 20 }] },
			),
			createParagraph(
				"(b) MAXIMUM AMOUNT OF AWARD PRIZES.—Subsection (c) of such section is amended—",
				{ startPage: 101, lines: [{ xStart: 20 }] },
			),
			createParagraph(
				"(1) in paragraph (1) by striking “$10,000,000” and inserting “$20,000,000”;",
				{ startPage: 101, lines: [{ xStart: 40 }] },
			),
			createParagraph(
				"(2) in paragraph (2) by striking “$1,000,000” and inserting “$2,000,000”; and",
				{ startPage: 101, lines: [{ xStart: 40 }] },
			),
			createParagraph(
				"(3) in paragraph (3) by striking “$10,000” and inserting “$20,000”.",
				{ startPage: 101, lines: [{ xStart: 40 }] },
			),
		];

		const instructions = extractAmendatoryInstructions(paragraphs);
		expect(instructions).toHaveLength(2);

		const instruction = instructions[1];
		expect(instruction.uscCitation).toBe("10 U.S.C. 4025");
		expect(instruction.rootQuery).toEqual([
			{ type: "section", val: "4025" },
			{ type: "subsection", val: "c" },
		]);

		const root = instruction.tree[0];
		expect(root?.operation.type).toBe("context");
		expect(root?.children).toHaveLength(3);

		expect(root?.children[0]?.operation.type).toBe("replace");
		expect(root?.children[0]?.operation.target).toEqual([
			{ type: "paragraph", val: "1" },
		]);
		expect(root?.children[0]?.operation.strikingContent).toBe("$10,000,000");
		expect(root?.children[0]?.operation.content).toBe("$20,000,000");

		expect(root?.children[1]?.operation.type).toBe("replace");
		expect(root?.children[1]?.operation.target).toEqual([
			{ type: "paragraph", val: "2" },
		]);
		expect(root?.children[1]?.operation.strikingContent).toBe("$1,000,000");
		expect(root?.children[1]?.operation.content).toBe("$2,000,000");

		expect(root?.children[2]?.operation.type).toBe("replace");
		expect(root?.children[2]?.operation.target).toEqual([
			{ type: "paragraph", val: "3" },
		]);
		expect(root?.children[2]?.operation.strikingContent).toBe("$10,000");
		expect(root?.children[2]?.operation.content).toBe("$20,000");
	});

	it("stops extraction at top-level division headers", () => {
		const paragraphs = [
			createParagraph(
				"Section 6(f) of the Food and Nutrition Act is amended to read as follows:",
				{ lines: [{ xStart: 20 }] },
			),
			createParagraph("“(f) No individual ...", {
				lines: [{ xStart: 20 }],
			}),
			createParagraph("“(1) a resident of the United States; and", {
				lines: [{ xStart: 40 }],
			}),
			createParagraph("“(2) either—", { lines: [{ xStart: 40 }] }),
			createParagraph("“(A) a citizen or national of the United States", {
				lines: [{ xStart: 60 }],
			}),
			createParagraph(
				"“(B) an alien lawfully admitted for ... in a foreign country;",
				{ lines: [{ xStart: 60 }] },
			),
			createParagraph(
				"“(C) an alien who ... section 501(e) of the Refugee Education Assistance Act of 1980 (Public Law 96–422); or",
				{ lines: [{ xStart: 60 }] },
			),
			createParagraph("“(D) an individual who ... individual is a member.”.", {
				lines: [{ xStart: 60 }],
			}),
			createParagraph("Subtitle B—Forestry", {
				startPage: 1,
				lines: [{ xStart: 100 }],
			}),
		];
		const instructions = extractAmendatoryInstructions(paragraphs);

		expect(instructions).toHaveLength(1);
		// Should not include the subtitle
		expect(instructions[0].text).not.toContain("Subtitle B—Forestry");
		expect(instructions[0].paragraphs).toHaveLength(8);
	});
});
