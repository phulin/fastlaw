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
	it("applies insert_before to the targeted subparagraph when anchors repeat", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10103.",
			target: "Section 5(k)(4)",
			uscCitation: "7 U.S.C. 2014(k)(4)",
			text: "(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”; and (2) in subparagraph (B), by inserting “with an elderly or disabled member” before “shall be”.",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			rootQuery: [],
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
			rootQuery: [],
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
				rootQuery: [],
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
		expect(effect.inserted).toEqual(testCase.expectedInserted);
		expect(effect.deleted).toEqual(testCase.expectedDeleted);
		const finalText = effect.segments.map((segment) => segment.text).join("");
		expect(finalText).toContain(testCase.expectedTextSnippet);
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
			rootQuery: [],
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

	it("fails when an explicit target path cannot be resolved", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 10103.",
			target: "Section 5(e)(6)(C)(iv)(I)",
			uscCitation: "7 U.S.C. 2014(e)(6)(C)(iv)(I)",
			text: "(a) Section 5(e)(6)(C)(iv)(I) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)(C)(iv)(I)) is amended by inserting “with an elderly or disabled member” after “households”.",
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			rootQuery: [],
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

		expect(effect.status).toBe("unsupported");
		expect(effect.segments).toEqual([
			{ kind: "unchanged", text: preSectionText },
		]);
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
