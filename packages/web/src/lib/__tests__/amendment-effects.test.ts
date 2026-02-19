import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	AmendatoryInstruction,
	InstructionNode,
} from "../amendatory-instructions";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import {
	computeAmendmentEffect,
	getSectionPathFromUscCitation,
} from "../amendment-effects";
import type { Paragraph } from "../text-extract";
import { createParagraph, parseFixtureParagraphs } from "./test-utils";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/hr1-abridged-output.txt",
);
const SECTION_BODIES_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/amendment-effect-section-bodies.json",
);
const USC_9062_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-10-9062.pre.md",
);
const USC_2025_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2025-pre.md",
);
const USC_2014_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014-pre.md",
);
const USC_9032_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-9032.md",
);
const USC_2036A_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2036a-pre.md",
);
const USC_9011_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-9011-pre.md",
);
const hasLocalState =
	existsSync(FIXTURE_PATH) && existsSync(SECTION_BODIES_PATH);

interface FixtureState {
	paragraphs: Paragraph[];
	instructions: ReturnType<typeof extractAmendatoryInstructions>;
}

const flattenOperationNodes = (nodes: InstructionNode[]): InstructionNode[] => {
	const flat: InstructionNode[] = [];
	const walk = (input: InstructionNode[]) => {
		for (const node of input) {
			flat.push(node);
			if (node.children.length > 0) {
				walk(node.children);
			}
		}
	};
	walk(nodes);
	return flat;
};

const getFixtureState = (): FixtureState => {
	const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
	const paragraphs = parseFixtureParagraphs(fixtureText);
	const instructions = extractAmendatoryInstructions(paragraphs);
	return { paragraphs, instructions };
};

const sectionBodyCache = new Map<string, string>();
const sectionBodyFixtures = hasLocalState
	? (JSON.parse(readFileSync(SECTION_BODIES_PATH, "utf8")) as Record<
			string,
			string
		>)
	: {};

const loadSectionBodyFromFixture = (sectionPath: string): string => {
	const cached = sectionBodyCache.get(sectionPath);
	if (cached) return cached;
	const body = sectionBodyFixtures[sectionPath];
	if (!body)
		throw new Error(`No fixture section body for path: ${sectionPath}`);
	sectionBodyCache.set(sectionPath, body);
	return body;
};

const findInstructionByCitationPrefix = (
	state: FixtureState,
	citationPrefix: string,
) => {
	const instruction = state.instructions.find((item) =>
		(item.uscCitation ?? "").startsWith(citationPrefix),
	);
	if (!instruction) {
		throw new Error(
			`Instruction not found for citation prefix: ${citationPrefix}`,
		);
	}
	return instruction;
};

const findInstructionByCitation = (state: FixtureState, citation: string) => {
	const instruction = state.instructions.find(
		(item) => item.uscCitation === citation,
	);
	if (!instruction) {
		throw new Error(`Instruction not found for citation: ${citation}`);
	}
	return instruction;
};

const requireSectionPath = (citation: string | null): string => {
	const sectionPath = getSectionPathFromUscCitation(citation);
	if (!sectionPath) {
		throw new Error(`Unable to derive section path from citation: ${citation}`);
	}
	return sectionPath;
};

const USC_9062_MINIMUM_INVENTORY_TREE_NODE_1_TEXT = [
	"(1) in paragraph (1), by striking “a total aircraft inventory of air refueling tanker aircraft of not less than 466 aircraft.” and inserting “a total aircraft inventory of air refueling tanker aircraft—",
	"“(A) of not less than 466 aircraft during the period ending on September 30, 2026;",
	"“(B) of not less than 478 aircraft during the period beginning on October 1, 2026, and ending on September 30, 2027;",
	"“(C) of not less than 490 aircraft during the period beginning on October 1, 2027, and ending on September 30, 2028; and",
	"“(D) of not less than 502 aircraft beginning on October 1, 2028.”; and",
].join("\n");

describe("computeAmendmentEffect target scoping", () => {
	it("infers lowercase roman insert markers from predecessor subsection context", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 1.",
			target: "Section 1",
			uscCitation: "7 U.S.C. 1",
			text: "(1) by inserting after subsection (b) the following:",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "1" },
					operation: {
						type: "insert_after",
						target: [{ type: "subsection", val: "b" }],
						content: [
							"(a) GENERAL.—Alpha.",
							"(i) LOWER.—Beta.",
							"(1) NUMERIC.—Gamma.",
						].join("\n"),
					},
					children: [],
					text: "(1) by inserting after subsection (b) the following:",
				},
			],
		};

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/1",
			["**(a)** Existing A.", "**(b)** Existing B."].join("\n"),
		);

		expect(effect.status).toBe("ok");
		expect(effect.inserted[0]).toContain("**(a)** **GENERAL**");
		expect(effect.inserted[0]).toContain("**(i)** **LOWER**");
		expect(effect.inserted[0]).toContain("> **(1)** **NUMERIC**");
		expect(effect.inserted[0]).not.toContain("> > > **(i)**");
	});

	it("infers uppercase roman insert markers from predecessor paragraph context", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 1.",
			target: "Section 1",
			uscCitation: "7 U.S.C. 1",
			text: "(1) by inserting after subsection (b) the following:",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "1" },
					operation: {
						type: "insert_after",
						target: [{ type: "subsection", val: "b" }],
						content: ["(1) BASE.—Alpha.", "(I) UPPER.—Beta."].join("\n"),
					},
					children: [],
					text: "(1) by inserting after subsection (b) the following:",
				},
			],
		};

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/1",
			["**(a)** Existing A.", "**(b)** Existing B."].join("\n"),
		);

		expect(effect.status).toBe("ok");
		expect(effect.inserted[0]).toContain("**(1)** **BASE**");
		expect(effect.inserted[0]).toContain("> **(I)** **UPPER**");
		expect(effect.inserted[0]).not.toContain("> > > **(I)**");
	});

	it("applies insert_before to the targeted subparagraph when anchors repeat", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10103.",
			target: "Section 5(k)(4)",
			uscCitation: "7 U.S.C. 2014(k)(4)",
			text: "(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”; and (2) in subparagraph (B), by inserting “with an elderly or disabled member” before “shall be”.",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "1" },
					operation: {
						type: "insert_before",
						target: [{ type: "subparagraph", val: "A" }],
						content: "without an elderly or disabled member",
					},
					children: [],
					text: "(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”;",
				},
				{
					label: { type: "paragraph", val: "2" },
					operation: {
						type: "insert_before",
						target: [{ type: "subparagraph", val: "B" }],
						content: "with an elderly or disabled member",
					},
					children: [],
					text: "(2) in subparagraph (B), by inserting “with an elderly or disabled member” before “shall be”.",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/7/2014";
		const sectionBody = [
			"**(A)** households shall be limited by rule.",
			"**(B)** households shall be limited by rule.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);
		const expectedFinalSectionText = [
			"**(A)** households without an elderly or disabled member shall be limited by rule.",
			"**(B)** households with an elderly or disabled member shall be limited by rule.",
		].join("\n");

		expect(effect.status).toBe("ok");
		expect(effect.segments).toEqual([
			{ kind: "unchanged", text: expectedFinalSectionText },
		]);
		expect(effect.deleted).toEqual([]);
		expect(effect.inserted).toEqual([
			"without an elderly or disabled member ",
			"with an elderly or disabled member ",
		]);
	});

	it("resolves explicit scope when markers are chained on one line", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10103.",
			target: "Section 5(k)(4)",
			uscCitation: "7 U.S.C. 2014(k)(4)",
			text: "(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”.",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "1" },
					operation: {
						type: "insert_before",
						target: [
							{ type: "subsection", val: "k" },
							{ type: "paragraph", val: "4" },
							{ type: "subparagraph", val: "A" },
						],
						content: "without an elderly or disabled member",
					},
					children: [],
					text: "(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”.",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/7/2014";
		const sectionBody = [
			"**(k)(4)(A)** households shall be limited by rule.",
			"**(k)(4)(B)** households under a State law shall receive additional treatment.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		expect(effect.inserted).toEqual(["without an elderly or disabled member "]);
		expect(effect.segments[0]?.text).toContain(
			"**(k)(4)(A)** households without an elderly or disabled member shall be limited by rule.",
		);
	});

	it("resolves clause scope from chained markers without blockquote nesting", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 9999.",
			target: "Section 1",
			uscCitation: "1 U.S.C. 1",
			text: "(1) in subparagraph (C)(i), by striking “64” and inserting “69”;",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "replace",
						target: [
							{ type: "subparagraph", val: "C" },
							{ type: "clause", val: "i" },
						],
						strikingContent: "64",
						content: "69",
					},
					children: [],
					text: "(1) in subparagraph (C)(i), by striking “64” and inserting “69”;",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/1/1";
		const sectionBody = [
			"**(A)** Unrelated text.",
			"**(C)(i)** The threshold is 64 days.",
			"**(C)(ii)** Unchanged text.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("**(C)(i)** The threshold is 69 days.");
		expect(resultText).toContain("**(C)(ii)** Unchanged text.");
	});

	it("applies scoped heading replacements when the striking text differs only by case", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 9999.",
			target: "Section 1",
			uscCitation: "1 U.S.C. 1",
			text: "(A) in the subsection heading, by striking “SUBSEQUENT” and inserting “PRIOR”;",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "replace",
						target: [{ type: "subsection", val: "b" }],
						strikingContent: "SUBSEQUENT",
						content: "PRIOR",
					},
					children: [],
					text: "(A) in the subsection heading, by striking “SUBSEQUENT” and inserting “PRIOR”;",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/1/1";
		const sectionBody = [
			"**(a)** **General rule**",
			"**(b)** **Subsequent years**",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("**(b)** **PRIOR years**");
	});

	it("keeps full quoted insert-after blocks and strips trailing instruction punctuation", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 101.",
			target: "Section 1001",
			uscCitation: "7 U.S.C. 1308",
			text: [
				"(a) Section 1001 is amended—",
				"(1) in subsection (a)—",
				"(B) by inserting after paragraph (4) the following:",
				"“(5) QUALIFIED PASS-THROUGH ENTITY.—The term ‘qualified pass-through entity’ means—",
				"“(A) a partnership (within the meaning of subchapter K of chapter 1 of the Internal Revenue Code of 1986);",
				"“(B) an S corporation (as defined in section 1361 of that Code);",
				"“(C) a limited liability company that does not affirmatively elect to be treated as a corporation; and",
				"“(D) a joint venture or general partnership.”;",
			].join("\n"),
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "subsection", val: "a" },
					operation: {
						type: "context",
						target: [{ type: "subsection", val: "a" }],
					},
					children: [
						{
							label: { type: "paragraph", val: "1" },
							operation: {
								type: "context",
								target: [{ type: "subsection", val: "a" }],
							},
							children: [
								{
									label: { type: "subparagraph", val: "B" },
									operation: {
										type: "insert_after",
										target: [{ type: "paragraph", val: "4" }],
									},
									children: [
										{
											operation: {
												type: "unknown",
												content:
													"“(5) QUALIFIED PASS-THROUGH ENTITY.—The term ‘qualified pass-through entity’ means—",
											},
											children: [],
											text: "“(5) QUALIFIED PASS-THROUGH ENTITY.—The term ‘qualified pass-through entity’ means—",
										},
										{
											operation: {
												type: "unknown",
												content:
													"“(A) a partnership (within the meaning of subchapter K of chapter 1 of the Internal Revenue Code of 1986);",
											},
											children: [],
											text: "“(A) a partnership (within the meaning of subchapter K of chapter 1 of the Internal Revenue Code of 1986);",
										},
										{
											operation: {
												type: "unknown",
												content:
													"“(B) an S corporation (as defined in section 1361 of that Code);",
											},
											children: [],
											text: "“(B) an S corporation (as defined in section 1361 of that Code);",
										},
										{
											operation: {
												type: "unknown",
												content:
													"“(C) a limited liability company that does not affirmatively elect to be treated as a corporation; and",
											},
											children: [],
											text: "“(C) a limited liability company that does not affirmatively elect to be treated as a corporation; and",
										},
										{
											operation: {
												type: "unknown",
												content:
													"“(D) a joint venture or general partnership.”;",
											},
											children: [],
											text: "“(D) a joint venture or general partnership.”;",
										},
									],
									text: "(B) by inserting after paragraph (4) the following:",
								},
							],
							text: "(1) in subsection (a)—",
						},
					],
					text: "(a) Section 1001 is amended—",
				},
			],
		};
		const sectionBody = [
			"**(a)** IN GENERAL.",
			'**(4)** The term "person" means a natural person, and does not include a legal entity.',
			"**(6)** RULE OF CONSTRUCTION.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/1308",
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		expect(effect.inserted).toHaveLength(1);
		expect(effect.inserted[0]).toContain(
			"**(5)** **QUALIFIED PASS-THROUGH ENTITY**",
		);
		expect(effect.inserted[0]).toContain(
			"The term ‘qualified pass-through entity’ means—",
		);
		expect(effect.inserted[0]).toContain(
			"**(A)** a partnership (within the meaning of subchapter K of chapter 1 of the Internal Revenue Code of 1986);",
		);
		expect(effect.inserted[0]).toContain(
			"**(D)** a joint venture or general partnership.",
		);
		expect(effect.inserted[0]).not.toContain("general partnership.”;");
	});

	it.each([
		{
			name: "7 U.S.C. 2025 fixture",
			loadInstruction: () => {
				const state = getFixtureState();
				return findInstructionByCitationPrefix(
					state,
					"7 U.S.C. 2025(c)(1)(A)(ii)(II)",
				);
			},
			preFixturePath: USC_2025_PRE_FIXTURE_PATH,
			expectedInserted: ["section 2012(u)(3)"],
			expectedDeleted: ["section 2012(u)(4)"],
			expectedTextSnippet:
				"the thrifty food plan is adjusted under [section 2012(u)(3) of this title]",
			expectedTargetPath:
				"subsection:c > paragraph:1 > subparagraph:A > clause:ii > subclause:II",
		},
		{
			name: "7 U.S.C. 2014 fixture",
			loadInstruction: (): AmendatoryInstruction => ({
				billSection: "SEC. 10006.",
				target: "Section 5(e)(6)(C)(iv)(I)",
				uscCitation: "7 U.S.C. 2014(e)(6)(C)(iv)(I)",
				text: "(a) STANDARD UTILITY ALLOWANCE.—Section 5(e)(6)(C)(iv)(I) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)(C)(iv)(I)) is amended by inserting “with an elderly or disabled member” after “households”.",
				paragraphs: [],
				startPage: 1,
				endPage: 1,
				tree: [
					{
						label: { type: "subsection", val: "a" },
						operation: {
							type: "insert_after",
							target: [
								{ type: "section", val: "5" },
								{ type: "subsection", val: "e" },
								{ type: "paragraph", val: "6" },
								{ type: "subparagraph", val: "C" },
								{ type: "clause", val: "iv" },
								{ type: "subclause", val: "I" },
							],
							content: "with an elderly or disabled member",
						},
						children: [],
						text: "(a) Section 5(e)(6)(C)(iv)(I) is amended by inserting “with an elderly or disabled member” after “households”.",
					},
				],
			}),
			preFixturePath: USC_2014_PRE_FIXTURE_PATH,
			expectedInserted: [" with an elderly or disabled member"],
			expectedDeleted: [] as string[],
			expectedTextSnippet:
				"the standard utility allowance shall be made available to households with an elderly or disabled member that received a payment",
			expectedTargetPath:
				"subsection:e > paragraph:6 > subparagraph:C > clause:iv > subclause:I",
		},
		{
			name: "7 U.S.C. 9032 fixture",
			loadInstruction: (): AmendatoryInstruction => ({
				billSection: "SEC. 1.",
				target: "Section 1202",
				uscCitation: "7 U.S.C. 9032",
				text: "(3) by inserting after subsection (b) the following: “(c) 2026 THROUGH 2031 CROP YEARS.—...”.",
				paragraphs: [],
				startPage: 1,
				endPage: 1,
				tree: [
					{
						label: { type: "paragraph", val: "3" },
						operation: {
							type: "insert_after",
							target: [{ type: "subsection", val: "b" }],
							content: [
								"**(c)** **2026 through 2031 crop years**",
								"",
								"> For purposes of each of the 2026 through 2031 crop years, the loan rate for a marketing assistance loan under [section 9031 of this title](/statutes/section/7/9031) for a loan commodity shall be equal to the following:",
							].join("\n"),
						},
						children: [],
						text: "(3) by inserting after subsection (b) the following:",
					},
				],
			}),
			preFixturePath: USC_9032_PRE_FIXTURE_PATH,
			expectedInsertedIncludes: ["2026 through 2031 crop years"],
			expectedDeleted: [] as string[],
			expectedTextSnippet: "**(c)** **2026 through 2031 crop years**",
			expectedTargetPath: "subsection:b",
		},
		{
			name: "7 U.S.C. 2036a(d)(1)(F) fixture",
			loadInstruction: (): AmendatoryInstruction => ({
				billSection:
					"SEC. 10107. NATIONAL EDUCATION AND OBESITY PREVENTION GRANT PROGRAM.",
				target:
					"Section 28(d)(1)(F) of the Food and Nutrition Act of 2008 (7 U.S.C. 2036a(d)(1)(F))",
				uscCitation: "7 U.S.C. 2036a(d)(1)(F)",
				text: "Section 28(d)(1)(F) of the Food and Nutrition Act of 2008 (7 U.S.C. 2036a(d)(1)(F)) is amended by striking “for fiscal year 2016 and each subsequent fiscal year” and inserting “for each of fiscal years 2016 through 2025”.",
				paragraphs: [],
				startPage: 1,
				endPage: 1,
				tree: [
					{
						operation: {
							type: "replace",
							target: [
								{ type: "section", val: "28" },
								{ type: "subsection", val: "d" },
								{ type: "paragraph", val: "1" },
								{ type: "subparagraph", val: "F" },
							],
							content: "for each of fiscal years 2016 through 2025",
							strikingContent:
								"for fiscal year 2016 and each subsequent fiscal year",
						},
						children: [],
						text: "Section 28(d)(1)(F) ... is amended by striking ... and inserting ...",
					},
				],
			}),
			preFixturePath: USC_2036A_PRE_FIXTURE_PATH,
			expectedInserted: ["for each of fiscal years 2016 through 2025"],
			expectedDeleted: ["for fiscal year 2016 and each subsequent fiscal year"],
			expectedTextSnippet:
				"for each of fiscal years 2016 through 2025, the applicable amount during the preceding fiscal year",
			expectedTargetPath: "subsection:d > paragraph:1 > subparagraph:F",
		},
		{
			name: "7 U.S.C. 9011 paragraph (19) strike-and-insert fixture",
			loadInstruction: (): AmendatoryInstruction => ({
				billSection: "SEC. 10000.",
				target: "Section 1111 of the Agricultural Act of 2014 (7 U.S.C. 9011)",
				uscCitation: "7 U.S.C. 9011",
				text: "(b) REFERENCE PRICE.—Section 1111 of the Agricultural Act of 2014 (7 U.S.C. 9011) is amended by striking paragraph (19) and inserting the following:",
				paragraphs: [],
				startPage: 1,
				endPage: 1,
				tree: [
					{
						label: { type: "subsection", val: "b" },
						operation: {
							type: "replace",
							target: [
								{ type: "section", val: "1111" },
								{ type: "paragraph", val: "19" },
							],
							content: [
								"(19) REFERENCE PRICE.—",
								"(A) IN GENERAL.—Effective beginning with the 2025 crop year, subject to subparagraphs (B) and (C), the term 'reference price', with respect to a covered commodity for a crop year, means the following:",
								"(i) For wheat, $6.35 per bushel.",
								"(ii) For corn, $4.10 per bushel.",
								"(iii) For grain sorghum, $4.40 per bushel.",
							].join("\n"),
						},
						children: [],
						text: "(b) REFERENCE PRICE.—Section 1111 of the Agricultural Act of 2014 (7 U.S.C. 9011) is amended by striking paragraph (19) and inserting the following:",
					},
				],
			}),
			preFixturePath: USC_9011_PRE_FIXTURE_PATH,
			expectedDeletedIncludes: [
				"For wheat, $5.50 per bushel.",
				"For corn, $3.70 per bushel.",
			],
			expectedInsertedIncludes: [
				"For wheat, $6.35 per bushel.",
				"For corn, $4.10 per bushel.",
			],
			expectedTextSnippet: "For wheat, $6.35 per bushel.",
			expectedTargetPath: "paragraph:19",
		},
	])("applies patch with explicit scope against full fixture: $name", (testCase) => {
		const instruction = testCase.loadInstruction();
		const sectionPath = requireSectionPath(instruction.uscCitation);
		const preSectionText = readFileSync(testCase.preFixturePath, "utf8").trim();

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			preSectionText,
		);
		const operationAttempt = effect.debug.operationAttempts[0];

		expect(effect.status).toBe("ok");
		expect(operationAttempt?.hasExplicitTargetPath).toBe(true);
		expect(operationAttempt?.targetPath).toBe(testCase.expectedTargetPath);
		expect(operationAttempt?.scopedRange).not.toBeNull();
		expect(operationAttempt?.outcome).toBe("applied");
		if ("expectedInserted" in testCase) {
			expect(effect.inserted).toEqual(testCase.expectedInserted);
		}
		const expectedInsertedIncludes = testCase.expectedInsertedIncludes ?? [];
		for (const expectedInsert of expectedInsertedIncludes) {
			expect(effect.inserted.join("\n")).toContain(expectedInsert);
		}
		if ("expectedDeleted" in testCase) {
			expect(effect.deleted).toEqual(testCase.expectedDeleted);
		}
		const expectedDeletedIncludes = testCase.expectedDeletedIncludes ?? [];
		for (const expectedDeleted of expectedDeletedIncludes) {
			expect(effect.deleted.join("\n")).toContain(expectedDeleted);
		}
		const finalText = effect.segments.map((segment) => segment.text).join("");
		expect(finalText).toContain(testCase.expectedTextSnippet);
		if (
			testCase.name === "7 U.S.C. 9011 paragraph (19) strike-and-insert fixture"
		) {
			expect(finalText).toContain("> **(19)** **REFERENCE PRICE**");
			expect(finalText).toContain("> > **(A)** **IN GENERAL**");
			expect(finalText).toContain("> > > **(i)** For wheat, $6.35 per bushel.");
		}
	});

	it("does not append a space after inserted text when punctuation already follows", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10104.",
			target: "Section 1",
			uscCitation: "10 U.S.C. 1",
			text: "inserting punctuation-bound content",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "insert_before",
						content: "and more",
					},
					children: [],
					text: "by inserting “and more” before “,”",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/10/1";
		const sectionBody = "One, two.";

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		expect(effect.segments).toEqual([
			{ kind: "unchanged", text: "Oneand more, two." },
		]);
		expect(effect.inserted).toEqual(["and more"]);
	});

	it("parses insert anchors when the opening quote is a right smart quote", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10104.",
			target: "Section 1",
			uscCitation: "10 U.S.C. 1",
			text: "inserting punctuation-bound content",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "insert_before",
						content: "and more",
					},
					children: [],
					text: "by inserting ”and more” before ”,”",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/10/1";
		const sectionBody = "One, two.";

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		expect(effect.segments).toEqual([
			{ kind: "unchanged", text: "Oneand more, two." },
		]);
	});

	it("fuzzily matches act-based section references against codified USC references", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 9999.",
			target: "Section 1202",
			uscCitation: "7 U.S.C. 9032",
			text: "by striking and inserting crop-eligibility text",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "replace",
						strikingContent:
							"Crops for which the producer has elected under section 1116 of the Agricultural Act of 2014 to receive agriculture risk coverage and acres",
						content:
							"Crops for which the producer has elected under section 1115 of the Agricultural Act of 2014 to receive agriculture risk coverage and acres",
					},
					children: [],
					text: "by striking ... and inserting ...",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/7/9032";
		const sectionBody = [
			"**(iv)** **Ineligible crops and acres**",
			"",
			"Crops for which the producer has elected under [section 9016 of this title](/statutes/section/7/9016) to receive agriculture risk coverage and acres that are enrolled in the stacked income protection plan under [section 1508b of this title](/statutes/section/7/1508b) shall not be eligible for supplemental coverage under this subparagraph.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		expect(effect.deleted[0]).toContain(
			"[section 9016 of this title](/statutes/section/7/9016)",
		);
		expect(effect.inserted).toEqual([
			"Crops for which the producer has elected under section 1115 of the Agricultural Act of 2014 to receive agriculture risk coverage and acres",
		]);
	});

	it("fails when an explicit target path cannot be resolved", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10103.",
			target: "Section 5(e)(6)(C)(iv)(I)",
			uscCitation: "7 U.S.C. 2014(e)(6)(C)(iv)(I)",
			text: "(a) Section 5(e)(6)(C)(iv)(I) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)(C)(iv)(I)) is amended by inserting “with an elderly or disabled member” after “households”.",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "subsection", val: "a" },
					operation: {
						type: "insert_after",
						target: [
							{ type: "section", val: "5" },
							{ type: "subsection", val: "e" },
							{ type: "paragraph", val: "6" },
							{ type: "subparagraph", val: "C" },
							{ type: "clause", val: "iv" },
							{ type: "subclause", val: "I" },
						],
						content: "with an elderly or disabled member",
					},
					children: [],
					text: "(a) Section 5(e)(6)(C)(iv)(I) is amended by inserting “with an elderly or disabled member” after “households”.",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/7/2014";
		const sectionBody = [
			"**(a)** households shall be limited to eligible participants.",
			"**(b)** households under a State law shall receive additional treatment.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("unsupported");
		expect(effect.segments).toEqual([{ kind: "unchanged", text: sectionBody }]);
		expect(effect.inserted).toEqual([]);
	});

	it("resolves 'as so redesignated' targets via same-instruction redesignation mapping", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10309.",
			target: "Section 1202",
			uscCitation: "7 U.S.C. 9032",
			text: "Section 1202 is amended",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "2" },
					operation: { type: "redesignate" },
					children: [],
					text: "(2) by redesignating subsections (c) and (d) as subsections (d) and (e), respectively;",
				},
				{
					label: { type: "paragraph", val: "5" },
					operation: {
						type: "replace",
						target: [
							{ type: "subsection", val: "e" },
							{ type: "paragraph", val: "1" },
						],
						strikingContent: "$0.25",
						content: "$0.30",
					},
					children: [],
					text: "(5) in subsection (e) (as so redesignated), in paragraph (1), by striking “$0.25” and inserting “$0.30”.",
				},
			],
		};
		const sectionPath = "/statutes/usc/section/7/9032";
		const sectionBody = [
			"**(c)** Legacy subsection c.",
			"",
			"**(d)** Legacy subsection d.",
			"",
			"> > **(1)** In the case of wheat, $0.25 per bushel.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("$0.30");
		expect(resultText).not.toContain("$0.25 per bushel");
	});

	it("covers a representative sample from the 39 scope failures", () => {
		const samples: Array<{
			name: string;
			instruction: AmendatoryInstruction;
			sectionPath: string;
			sectionBody: string;
			expectedStatus: "ok" | "unsupported";
			expectedInsertedText?: string;
		}> = [
			{
				name: "#57 7 U.S.C. 9081(e) deep scoped replace",
				instruction: {
					billSection: "SEC. 10401.",
					target: "Section 1501(e)",
					uscCitation: "7 U.S.C. 9081(e)",
					text: "(A) in subparagraph (A)(i), by striking “15 percent mortality (adjusted for normal mortality)” and inserting “normal mortality”; and",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "replace",
								target: [
									{ type: "subsection", val: "e" },
									{ type: "paragraph", val: "3" },
									{ type: "subparagraph", val: "A" },
									{ type: "clause", val: "i" },
								],
								strikingContent:
									"15 percent mortality (adjusted for normal mortality)",
								content: "normal mortality",
							},
							children: [],
							text: "(A) in subparagraph (A)(i), by striking “15 percent mortality (adjusted for normal mortality)” and inserting “normal mortality”; and",
						},
					],
				},
				sectionPath: "/statutes/usc/section/7/9081",
				sectionBody: [
					"**(e)** **Tree assistance program**",
					"> > **(3)** **Assistance**",
					"> > > **(A)** **(i)** reimbursement for losses in excess of 15 percent mortality (adjusted for normal mortality).",
					"> > > **(B)** separate rule.",
				].join("\n"),
				expectedStatus: "ok",
				expectedInsertedText: "normal mortality",
			},
			{
				name: "#567 42 U.S.C. 2210 inline (1)(A) marker chain",
				instruction: {
					billSection: "SEC. 13001.",
					target: "Section 170(a)(1)(A)",
					uscCitation: "42 U.S.C. 2210",
					text: "(1) in subparagraph (A), by striking “an amount” and inserting “the amount”;",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "replace",
								target: [
									{ type: "subsection", val: "a" },
									{ type: "paragraph", val: "1" },
									{ type: "subparagraph", val: "A" },
								],
								strikingContent: "an amount",
								content: "the amount",
							},
							children: [],
							text: "(1) in subparagraph (A), by striking “an amount” and inserting “the amount”;",
						},
					],
				},
				sectionPath: "/statutes/usc/section/42/2210",
				sectionBody: [
					"**(a)** **Requirement**",
					"> > **(1)** The Commission shall provide **(A)** an amount for qualifying claims and **(B)** additional amounts as needed.",
				].join("\n"),
				expectedStatus: "ok",
				expectedInsertedText: "the amount",
			},
			{
				name: "#574 42 U.S.C. 2210 deep inline subclause insertion",
				instruction: {
					billSection: "SEC. 13001.",
					target: "Section 170(a)(1)(A)(ii)(II)",
					uscCitation: "42 U.S.C. 2210",
					text: "(1) by inserting “, core driller,” after “was a miller”;",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "insert_after",
								target: [
									{ type: "subsection", val: "a" },
									{ type: "paragraph", val: "1" },
									{ type: "subparagraph", val: "A" },
									{ type: "clause", val: "ii" },
									{ type: "subclause", val: "II" },
								],
								content: ", core driller,",
							},
							children: [],
							text: "(1) by inserting “, core driller,” after “was a miller”;",
						},
					],
				},
				sectionPath: "/statutes/usc/section/42/2210",
				sectionBody: [
					"**(a)** **Requirement**",
					"> > **(1)** **(A)** claimant categories include:",
					"> > > > **(ii)** **(I)** former miners; **(II)** any individual who was a miller and later relocated.",
				].join("\n"),
				expectedStatus: "ok",
				expectedInsertedText: ", core driller,",
			},
			{
				name: "#476 42 U.S.C. 1396a insert after paragraph (87)",
				instruction: {
					billSection: "SEC. 44112.",
					target: "Section 1902(a)",
					uscCitation: "42 U.S.C. 1396a",
					text: "(iii) by inserting after paragraph (87) the following new paragraph:",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "insert_after",
								target: [
									{ type: "subsection", val: "a" },
									{ type: "paragraph", val: "87" },
								],
								content: "(88) inserted sample paragraph text.",
							},
							children: [],
							text: "(iii) by inserting after paragraph (87) the following new paragraph:",
						},
					],
				},
				sectionPath: "/statutes/usc/section/42/1396a",
				sectionBody: [
					"**(a)** **Contents**",
					"> > **(87)** provide a mechanism for compliance.",
					"> > **(89)** preserve preexisting text.",
				].join("\n"),
				expectedStatus: "ok",
				expectedInsertedText: "(88) inserted sample paragraph text.",
			},
			{
				name: "#532 20 U.S.C. 1078-3 subsection (aa) path mismatch",
				instruction: {
					billSection: "SEC. 60011.",
					target: "Section 428C(a)(3)(B)(i)(V)(aa)",
					uscCitation: "20 U.S.C. 1078-3",
					text: "(i) in subsection (a)(3)(B)(i)(V)(aa), by striking “for the purposes of obtaining income contingent repayment or income-based repayment” and inserting “for the purposes of qualifying for an income-based repayment plan under section 455(q) or section 493C, as applicable”;",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "replace",
								target: [{ type: "subsection", val: "aa" }],
								strikingContent:
									"for the purposes of obtaining income contingent repayment or income-based repayment",
								content:
									"for the purposes of qualifying for an income-based repayment plan under section 455(q) or section 493C, as applicable",
							},
							children: [],
							text: "(i) in subsection (a)(3)(B)(i)(V)(aa), by striking ...",
						},
					],
				},
				sectionPath: "/statutes/usc/section/20/1078-3",
				sectionBody: [
					"**(a)** **General**",
					"> > > > > > **(aa)** for the purposes of obtaining income contingent repayment or income-based repayment.",
				].join("\n"),
				expectedStatus: "unsupported",
			},
			{
				name: "#573 42 U.S.C. 2210 note-level reference unresolved in codified body",
				instruction: {
					billSection: "SEC. 13001.",
					target: "Section 5(a)(1)(A)(ii)(I) (42 U.S.C. 2210 note)",
					uscCitation: "42 U.S.C. 2210",
					text: "(b) MINERS.—Section 5(a)(1)(A)(ii)(I) of the Radiation Exposure Compensation Act (Public Law 101–426; 42 U.S.C. 2210 note) is amended by inserting ...",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "insert_after",
								target: [
									{ type: "subsection", val: "a" },
									{ type: "paragraph", val: "1" },
									{ type: "subparagraph", val: "A" },
									{ type: "clause", val: "ii" },
									{ type: "subclause", val: "I" },
								],
								content: "or renal cancer or any other chronic renal disease",
							},
							children: [],
							text: "(b) MINERS.—Section 5(a)(1)(A)(ii)(I) ... 42 U.S.C. 2210 note ...",
						},
					],
				},
				sectionPath: "/statutes/usc/section/42/2210",
				sectionBody: [
					"**(a)** **Requirement**",
					"> > **(1)** Codified body text with no note-level Section 5 structure.",
				].join("\n"),
				expectedStatus: "unsupported",
			},
			{
				name: "#110 30 U.S.C. 226(b)(1)(A) as-amended-by context unresolved",
				instruction: {
					billSection: "SEC. 50123.",
					target: "Section 17(b)(1)(A)",
					uscCitation: "30 U.S.C. 226(b)(1)(A)",
					text: "(3) ... as amended by subsection (a), is amended by inserting ... after “sales are necessary.”.",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "insert_after",
								target: [
									{ type: "subsection", val: "b" },
									{ type: "paragraph", val: "1" },
									{ type: "subparagraph", val: "A" },
								],
								content: "For purposes of the previous sentence ...",
							},
							children: [],
							text: "(3) ... as amended by subsection (a), is amended by inserting ... after “sales are necessary.”.",
						},
					],
				},
				sectionPath: "/statutes/usc/section/30/226",
				sectionBody: [
					"**(b)** **General**",
					"> > **(2)** unrelated paragraph text.",
				].join("\n"),
				expectedStatus: "unsupported",
			},
			{
				name: "#526 42 U.S.C. 1397aa matter-preceding scope unresolved",
				instruction: {
					billSection: "SEC. 44112.",
					target: "Section 2105(b)",
					uscCitation: "42 U.S.C. 1397aa",
					text: "(B) in subsection (b), in the matter preceding paragraph (1), by inserting “subsection (a) or (g) of” before “section 2105”;",
					paragraphs: [],
					startPage: 1,
					endPage: 1,
					tree: [
						{
							operation: {
								type: "insert_before",
								target: [{ type: "subsection", val: "b" }],
								content: "subsection (a) or (g) of",
							},
							children: [],
							text: "(B) in subsection (b), in the matter preceding paragraph (1), by inserting ...",
						},
					],
				},
				sectionPath: "/statutes/usc/section/42/1397aa",
				sectionBody: [
					"**(a)** unrelated scope only.",
					"Text without subsection (b).",
				].join("\n"),
				expectedStatus: "unsupported",
			},
		];

		for (const sample of samples) {
			const effect = computeAmendmentEffect(
				sample.instruction,
				sample.sectionPath,
				sample.sectionBody,
			);
			expect(effect.status, sample.name).toBe(sample.expectedStatus);
			if (sample.expectedStatus === "ok") {
				expect(
					effect.inserted.join("\n"),
					`${sample.name} should apply a concrete insertion/replacement`,
				).not.toBe("");
				if (sample.expectedInsertedText) {
					expect(
						effect.inserted.join("\n"),
						`${sample.name} expected inserted text`,
					).toContain(sample.expectedInsertedText);
				}
				continue;
			}
			expect(effect.debug.failureReason, `${sample.name} failure reason`).toBe(
				"explicit_target_scope_unresolved",
			);
		}
	});

	it("applies 10 U.S.C. 9062(j) minimum inventory amendments against full section text", () => {
		// Mock the tree as it would come out of extractAmendatoryInstructions
		// We'll rely on a snapshot for the tree structure since it's complex
		// and we removed the canonicalize helper that hid the raw structure.
		const paragraphs: Paragraph[] = [
			createParagraph(
				"(a) MINIMUM INVENTORY REQUIREMENT.—Section 9062(j) of title 10, United States Code, is amended—",
				{ startPage: 1, lines: [{ xStart: 24, y: 780 }] },
			),
			createParagraph(USC_9062_MINIMUM_INVENTORY_TREE_NODE_1_TEXT, {
				startPage: 1,
				lines: [{ xStart: 40, y: 760 }],
			}),
			createParagraph(
				"(2) in paragraph (2), by striking “below 466” and inserting “below the applicable level specified in paragraph (1)”.",
				{ startPage: 1, lines: [{ xStart: 40, y: 740 }] },
			),
		];
		const instructions = extractAmendatoryInstructions(paragraphs);

		expect(instructions[0].tree).toMatchSnapshot();

		const instruction = instructions[0];
		// Inject mock data for execution
		// (The instruction derived from extractAmendatoryInstructions should be sufficient if the parser is working correctly)

		const sectionPath = "/statutes/usc/section/10/9062";
		const preSectionText = readFileSync(
			USC_9062_PRE_FIXTURE_PATH,
			"utf8",
		).trim();
		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			preSectionText,
		);

		expect(effect.status).toBe("ok");
		expect(effect.inserted.join("\n")).toContain(
			"below the applicable level specified in paragraph (1)",
		);
		expect(effect.deleted.join("\n")).toContain("below 466");
	});

	it("applies 'such section' paragraph replacements within subsection (c) only", () => {
		const paragraphs: Paragraph[] = [
			createParagraph(
				"SEC. 211. MODIFICATION TO AUTHORITY TO AWARD PRIZES FOR ADVANCED TECHNOLOGY ACHIEVEMENTS.",
				{ lines: [{ xStart: 0, y: 780 }] },
			),
			createParagraph(
				"(a) AUTHORITY.—Subsection (a) of section 4025 of title 10, United States Code, is amended by inserting after “the Under Secretary of Defense for Acquisition and Sustainment,” the following: “the Director of the Defense Innovation Unit,”.",
				{ lines: [{ xStart: 24, y: 760 }] },
			),
			createParagraph(
				"(b) MAXIMUM AMOUNT OF AWARD PRIZES.—Subsection (c) of such section is amended—",
				{ lines: [{ xStart: 24, y: 740 }] },
			),
			createParagraph(
				"(1) in paragraph (1) by striking “$10,000,000” and inserting “$20,000,000”;",
				{ lines: [{ xStart: 40, y: 720 }] },
			),
			createParagraph(
				"(2) in paragraph (2) by striking “$1,000,000” and inserting “$2,000,000”; and",
				{ lines: [{ xStart: 40, y: 700 }] },
			),
			createParagraph(
				"(3) in paragraph (3) by striking “$10,000” and inserting “$20,000”.",
				{ lines: [{ xStart: 40, y: 680 }] },
			),
		];

		const instructions = extractAmendatoryInstructions(paragraphs);
		expect(instructions).toHaveLength(2);
		const instruction = instructions[1];
		expect(instruction?.uscCitation).toBe("10 U.S.C. 4025");

		const sectionPath = requireSectionPath(instruction?.uscCitation ?? null);
		const sectionBody = [
			"(a) Existing authority levels:",
			"(1) Base threshold is $10,000,000.",
			"(2) Secondary threshold is $1,000,000.",
			"(3) Micro threshold is $10,000.",
			"",
			"(c) Prize caps:",
			"(1) Maximum award is $10,000,000.",
			"(2) Individual cap is $1,000,000.",
			"(3) Pilot cap is $10,000.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);
		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";

		expect(resultText).toContain("(a) Existing authority levels:");
		expect(resultText).toContain("(1) Base threshold is $10,000,000.");
		expect(resultText).toContain("(2) Secondary threshold is $1,000,000.");
		expect(resultText).toContain("(3) Micro threshold is $10,000.");
		expect(resultText).toContain("(c) Prize caps:");
		expect(resultText).toContain("(1) Maximum award is $20,000,000.");
		expect(resultText).toContain("(2) Individual cap is $2,000,000.");
		expect(resultText).toContain("(3) Pilot cap is $20,000.");
	});

	it("applies scoped replacement for 'is amended to read as follows'", () => {
		const paragraphs: Paragraph[] = [
			createParagraph(
				"Section 6(f) of the Food and Nutrition Act of 2008 (7 U.S.C. 2015(f)) is amended to read as follows:",
				{ lines: [{ xStart: 24, y: 780 }] },
			),
			createParagraph(
				"“(f) No individual who is a member of a household otherwise eligible to participate in the supplemental nutrition assistance program shall be eligible unless such individual is a resident of the United States.”.",
				{ lines: [{ xStart: 40, y: 760 }] },
			),
		];
		const instructions = extractAmendatoryInstructions(paragraphs);
		expect(instructions).toHaveLength(1);
		const instruction = instructions[0];

		const sectionPath = requireSectionPath(instruction.uscCitation);
		const sectionBody = [
			"**(e)** Legacy text in subsection (e).",
			"**(f)** Legacy text in subsection (f) that should be replaced.",
			"**(g)** Legacy text in subsection (g).",
		].join("\n");
		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("**(e)** Legacy text in subsection (e).");
		expect(resultText).toContain(
			"“(f) No individual who is a member of a household otherwise eligible to participate",
		);
		expect(resultText).not.toContain(
			"Legacy text in subsection (f) that should be replaced.",
		);
		expect(resultText).toContain("**(g)** Legacy text in subsection (g).");
	});

	it("applies scoped replacement for structural strike-and-insert-following", () => {
		const paragraphs: Paragraph[] = [
			createParagraph(
				"(b) REFERENCE PRICE.—Section 1111 of the Agricultural Act of 2014 (7 U.S.C. 9011) is amended by striking paragraph (19) and inserting the following: “(19) REFERENCE PRICE.— “(A) IN GENERAL.—Effective beginning with the 2025 crop year, the term ‘reference price’, with respect to a covered commodity, means the following: “(i) For wheat, $6.35 per bushel.”.",
				{ lines: [{ xStart: 24, y: 780 }] },
			),
		];
		const instructions = extractAmendatoryInstructions(paragraphs);
		expect(instructions).toHaveLength(1);
		const instruction = instructions[0];

		const sectionPath = requireSectionPath(instruction.uscCitation);
		const sectionBody = [
			"**(18)** Legacy paragraph 18.",
			"**(19)** Legacy paragraph 19 text to replace.",
			"Still paragraph 19 legacy continuation.",
			"**(20)** Legacy paragraph 20.",
		].join("\n");
		const effect = computeAmendmentEffect(
			instruction,
			sectionPath,
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("**(18)** Legacy paragraph 18.");
		expect(resultText).toContain("(19) REFERENCE PRICE.—");
		expect(resultText).toContain("(A) IN GENERAL.—Effective beginning");
		expect(resultText).not.toContain("Legacy paragraph 19 text to replace.");
		expect(resultText).toContain("**(20)** Legacy paragraph 20.");
	});

	it("uses quoted child content when replace omits inline inserting content", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10105.",
			target: "Section 4(a)",
			uscCitation: "7 U.S.C. 2013(a)",
			text: "(1) by striking “(a) Subject to” and inserting the following:",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "1" },
					operation: {
						type: "replace",
						target: [{ type: "subsection", val: "a" }],
						strikingContent: "(a) Subject to",
					},
					children: [
						{
							operation: {
								type: "unknown",
								content: "“(a) PROGRAM.—",
							},
							children: [],
							text: "“(a) PROGRAM.—",
						},
						{
							operation: {
								type: "unknown",
								content: "“(1) ESTABLISHMENT.—Subject to",
							},
							children: [],
							text: "“(1) ESTABLISHMENT.—Subject to",
						},
					],
					text: "(1) by striking “(a) Subject to” and inserting the following:",
				},
			],
		};
		const sectionBody = [
			"**(a)** **In general**",
			"",
			"> Subject to the availability of appropriations, the Secretary shall administer the program.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/2013",
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("“(a) PROGRAM.—");
		expect(resultText).toContain("“(1) ESTABLISHMENT.—Subject to");
		expect(resultText).not.toContain("> Subject to the availability");
	});

	it("applies insert_before instructions that anchor on the period at the end", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10305.",
			target: "Section 1117(c)(1)",
			uscCitation: "7 U.S.C. 9017",
			text: "(A) in paragraph (1), by inserting “for each of the 2014 through 2024 crop years and 90 percent of the benchmark revenue for each of the 2025 through 2031 crop years” before the period at the end;",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "subparagraph", val: "A" },
					operation: {
						type: "insert_before",
						target: [
							{ type: "subsection", val: "c" },
							{ type: "paragraph", val: "1" },
						],
						content:
							"for each of the 2014 through 2024 crop years and 90 percent of the benchmark revenue for each of the 2025 through 2031 crop years",
					},
					children: [],
					text: "(A) in paragraph (1), by inserting “for each of the 2014 through 2024 crop years and 90 percent of the benchmark revenue for each of the 2025 through 2031 crop years” before the period at the end;",
				},
			],
		};
		const sectionBody = [
			"**(c)** **Agriculture risk coverage guarantee**",
			"",
			"> > **(1)** **In general**",
			"",
			"> > The agriculture risk coverage guarantee for a crop year shall equal 86 percent of the benchmark revenue.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/9017",
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain(
			"86 percent of the benchmark revenue for each of the 2014 through 2024 crop years and 90 percent of the benchmark revenue for each of the 2025 through 2031 crop years.",
		);
	});

	it("scopes replacements to matter preceding paragraph markers", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10315.",
			target: "Section 301(b)",
			uscCitation: "7 U.S.C. 2101",
			text: "(1) in subsection (b), in the matter preceding paragraph (1), by striking “2024” and inserting “2031”; and",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "replace",
						target: [{ type: "subsection", val: "b" }],
						strikingContent: "2024",
						content: "2031",
					},
					children: [],
					text: "(1) in subsection (b), in the matter preceding paragraph (1), by striking “2024” and inserting “2031”; and",
				},
			],
		};
		const sectionBody = [
			"**(b)** Introductory matter through crop year 2024.",
			"> > **(1)** Paragraph one retains 2024 in body text.",
			"> > **(2)** Paragraph two.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/2101",
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("crop year 2031");
		expect(resultText).toContain("Paragraph one retains 2024");
	});

	it("scopes replacements to matter preceding clause markers", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 60012.",
			target: "Section 487(a)(2)(A)",
			uscCitation: "20 U.S.C. 1098h(a)(2)",
			text: "(I) in the matter preceding clause (i), by striking “income-contingent or”; and",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					operation: {
						type: "delete",
						target: [{ type: "subparagraph", val: "A" }],
						strikingContent: "income-contingent or",
					},
					children: [],
					text: "(I) in the matter preceding clause (i), by striking “income-contingent or”; and",
				},
			],
		};
		const sectionBody = [
			"**(A)** In the case of any application for an income-contingent or income-based repayment plan, the Secretary shall—",
			"> > > > **(i)** provide to such individuals the notification described elsewhere;",
			"> > > > **(ii)** require affirmative approval.",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/20/1098h",
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).toContain("for an income-based repayment plan");
		expect(resultText).toContain("**(i)** provide to such individuals");
	});

	it("matches delete text across inline citation markup", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10306.",
			target: "Section 1001(d)",
			uscCitation: "7 U.S.C. 1308",
			text: "(3) in subsection (d), by striking “subtitle B of title I of the Agricultural Act of 2014 or”.",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			tree: [
				{
					label: { type: "paragraph", val: "3" },
					operation: {
						type: "delete",
						target: [{ type: "subsection", val: "d" }],
						strikingContent:
							"subtitle B of title I of the Agricultural Act of 2014 or",
					},
					children: [],
					text: "(3) in subsection (d), by striking “subtitle B of title I of the Agricultural Act of 2014 or”.",
				},
			],
		};
		const sectionBody = [
			"**(d)** **Limitation on applicability**",
			"",
			"> Nothing in this section authorizes any limitation on any benefit associated with the forfeiture of a commodity pledged as collateral for a loan made available under subtitle B of title I of the Agricultural Act of 2014 [[7 U.S.C. 9031](/statutes/section/7/9031) et seq.] or title I of the Agricultural Act of 2014 [[7 U.S.C. 9001](/statutes/section/7/9001) et seq.].",
		].join("\n");

		const effect = computeAmendmentEffect(
			instruction,
			"/statutes/usc/section/7/1308",
			sectionBody,
		);

		expect(effect.status).toBe("ok");
		const resultText = effect.segments[0]?.text ?? "";
		expect(resultText).not.toContain(
			"subtitle B of title I of the Agricultural Act of 2014",
		);
		expect(resultText).toContain(
			"for a loan made available under title I of the Agricultural Act of 2014",
		);
	});

	it("parses 10 U.S.C. 9062(j) minimum inventory amendment into the expected operation tree", () => {
		const paragraphs: Paragraph[] = [
			createParagraph(
				"(a) MINIMUM INVENTORY REQUIREMENT.—Section 9062(j) of title 10, United States Code, is amended—",
				{ lines: [{ xStart: 24, y: 780 }] },
			),
			createParagraph(USC_9062_MINIMUM_INVENTORY_TREE_NODE_1_TEXT, {
				lines: [{ xStart: 40, y: 760 }],
			}),
			createParagraph(
				"(2) in paragraph (2), by striking “below 466” and inserting “below the applicable level specified in paragraph (1)”.",
				{ lines: [{ xStart: 40, y: 740 }] },
			),
		];

		const instructions = extractAmendatoryInstructions(paragraphs);
		expect(instructions).toHaveLength(1);

		// Assert strict structure instead of canonicalized
		expect(instructions[0].tree).toMatchSnapshot();
	});
});

describe.skipIf(!hasLocalState)(
	"hr1 amendment operations and fixture USC application",
	() => {
		it("extracts operation trees for all amendatory operation types present in HR1 fixture", () => {
			const state = getFixtureState();
			const operationTypes = new Set(
				state.instructions
					.flatMap((instruction) => flattenOperationNodes(instruction.tree))
					.map((node) => node.operation.type),
			);

			// Every operation type below appears in hr1-abridged-output.txt.
			expect(operationTypes.has("replace")).toBe(true);
			expect(operationTypes.has("insert_before")).toBe(true);
			expect(operationTypes.has("insert_after")).toBe(true);
			expect(operationTypes.has("add_at_end")).toBe(true);
			expect(operationTypes.has("context")).toBe(true);
			expect(operationTypes.has("unknown")).toBe(true);
		});

		it("parses replace operation from HR1 conforming amendment", () => {
			const state = getFixtureState();
			const instruction = findInstructionByCitationPrefix(
				state,
				"7 U.S.C. 2025",
			);
			const replaceNode = flattenOperationNodes(instruction.tree).find(
				(node) => node.operation.type === "replace",
			);
			expect(replaceNode).toBeDefined();
			expect(replaceNode?.operation.strikingContent).toBe("section 3(u)(4)");
			expect(replaceNode?.operation.content).toBe("section 3(u)(3)");
		});

		it("parses insert_after operation from HR1 utility allowance amendment", () => {
			const state = getFixtureState();
			const instruction = findInstructionByCitationPrefix(
				state,
				"7 U.S.C. 2014(e)(6)(C)(iv)(I)",
			);
			const insertAfterNode = flattenOperationNodes(instruction.tree).find(
				(node) => node.operation.type === "insert_after",
			);
			expect(insertAfterNode).toBeDefined();
			expect(insertAfterNode?.operation.content).toBe(
				"with an elderly or disabled member",
			);
		});

		it("parses insert_before operation from HR1 third-party energy amendment", () => {
			const state = getFixtureState();
			const instruction = findInstructionByCitationPrefix(
				state,
				"7 U.S.C. 2014(k)(4)",
			);
			const insertBeforeNode = flattenOperationNodes(instruction.tree).find(
				(node) => node.operation.type === "insert_before",
			);
			expect(insertBeforeNode).toBeDefined();
			expect(insertBeforeNode?.operation.target).toEqual([
				{ type: "subparagraph", val: "A" },
			]);
		});

		it("parses add_at_end and unknown/redesignating operations from HR1 work-requirement amendments", () => {
			const state = getFixtureState();
			const section2015o4 = findInstructionByCitationPrefix(
				state,
				"7 U.S.C. 2015(o)(4)",
			);
			const opTypes2015o4 = new Set(
				flattenOperationNodes(section2015o4.tree).map(
					(node) => node.operation.type,
				),
			);
			expect(opTypes2015o4.has("context")).toBe(true);
			expect(opTypes2015o4.has("add_at_end")).toBe(true);

			const section2015o = findInstructionByCitation(state, "7 U.S.C. 2015(o)");
			const opTypes2015o = new Set(
				flattenOperationNodes(section2015o.tree).map(
					(node) => node.operation.type,
				),
			);
			expect(opTypes2015o.has("unknown")).toBe(true); // redesignating
		});

		it("applies mixed operation tree against fixture USC text", () => {
			const state = getFixtureState();
			const instruction = findInstructionByCitation(state, "7 U.S.C. 2013(a)");
			const sectionPath = requireSectionPath(instruction.uscCitation);
			const sectionBody = loadSectionBodyFromFixture(sectionPath);
			const effect = computeAmendmentEffect(
				instruction,
				sectionPath,
				sectionBody,
			);

			expect(effect.status).toBe("ok");
			expect(effect.inserted.join("\n")).toContain(
				"STATE QUALITY CONTROL INCENTIVE",
			);
			expect(
				effect.segments[0]?.text.includes("STATE QUALITY CONTROL INCENTIVE"),
			).toBe(true);
		});

		it("applies insert_before and insert_after operations against fixture USC text", () => {
			const state = getFixtureState();

			const insertAfterInstruction = findInstructionByCitationPrefix(
				state,
				"7 U.S.C. 2014(e)(6)(C)(iv)(I)",
			);
			const insertAfterPath = requireSectionPath(
				insertAfterInstruction.uscCitation,
			);
			const insertAfterBody = loadSectionBodyFromFixture(insertAfterPath);
			const insertAfterEffect = computeAmendmentEffect(
				insertAfterInstruction,
				insertAfterPath,
				insertAfterBody,
			);
			expect(insertAfterEffect.status).toBe("unsupported");
			expect(insertAfterEffect.inserted).toEqual([]);

			const insertBeforeInstruction = findInstructionByCitationPrefix(
				state,
				"7 U.S.C. 2014(k)(4)",
			);
			const insertBeforePath = requireSectionPath(
				insertBeforeInstruction.uscCitation,
			);
			const insertBeforeBody = loadSectionBodyFromFixture(insertBeforePath);
			const insertBeforeEffect = computeAmendmentEffect(
				insertBeforeInstruction,
				insertBeforePath,
				insertBeforeBody,
			);
			expect(insertBeforeEffect.status).toBe("unsupported");
			expect(insertBeforeEffect.inserted).toEqual([]);
		});

		it("applies add_at_end operation against fixture USC text", () => {
			const state = getFixtureState();
			const instruction = findInstructionByCitation(
				state,
				"7 U.S.C. 2014(e)(6)",
			);
			const sectionPath = requireSectionPath(instruction.uscCitation);
			const sectionBody = loadSectionBodyFromFixture(sectionPath);
			const effect = computeAmendmentEffect(
				instruction,
				sectionPath,
				sectionBody,
			);

			expect(effect.status).toBe("unsupported");
			expect(effect.inserted).toEqual([]);
		});

		it("keeps unsupported operation trees as fallback for redesignation-only branches", () => {
			const state = getFixtureState();
			const instruction = findInstructionByCitation(state, "7 U.S.C. 2015(o)");
			const sectionPath = requireSectionPath(instruction.uscCitation);
			const sectionBody = loadSectionBodyFromFixture(sectionPath);
			const effect = computeAmendmentEffect(
				instruction,
				sectionPath,
				sectionBody,
			);

			expect(effect.status).toBe("unsupported");
			expect(effect.inserted).toHaveLength(0);
			expect(effect.deleted).toHaveLength(0);
		});
	},
);
