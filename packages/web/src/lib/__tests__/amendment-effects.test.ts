import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	AmendatoryInstruction,
	HierarchyLevel,
	InstructionNode,
} from "../amendatory-instructions";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import {
	computeAmendmentEffect,
	getSectionPathFromUscCitation,
} from "../amendment-effects";
import type { Paragraph } from "../text-extract";

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

const hasLocalState =
	existsSync(FIXTURE_PATH) && existsSync(SECTION_BODIES_PATH);

interface FixtureState {
	paragraphs: Paragraph[];
	instructions: ReturnType<typeof extractAmendatoryInstructions>;
}

const parseFixtureParagraphs = (text: string): Paragraph[] => {
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
		const pageMatch = rawLine.match(/^Page\s+(\d+)/);
		if (pageMatch) {
			page = Number(pageMatch[1]);
			y = 780;
			continue;
		}

		if (!rawLine.startsWith("[*] ")) continue;
		const textValue = rawLine.slice(4).trim();
		if (!textValue) continue;

		const xStart = indentFor(textValue);
		const paragraph: Paragraph = {
			text: textValue,
			lines: [
				{
					xStart,
					xEnd: xStart + Math.max(10, textValue.length * 3),
					y,
					yStart: y,
					yEnd: y + 10,
					text: textValue,
					items: [],
					page,
					pageHeight: 800,
				},
			],
			startPage: page,
			endPage: page,
			confidence: 1,
			y,
			yStart: y,
			yEnd: y + 10,
			pageHeight: 800,
		};
		paragraphs.push(paragraph);
		y -= 12;
		if (y < 40) y = 780;
	}

	return paragraphs;
};

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
						content: "without an elderly or disabled member ",
					},
					children: [],
					text: "(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”;",
				},
				{
					label: { type: "paragraph", val: "2" },
					operation: {
						type: "insert_before",
						target: [{ type: "subparagraph", val: "B" }],
						content: "with an elderly or disabled member ",
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
				{ type: "subparagraph", val: "A" } satisfies HierarchyLevel,
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
			expect(insertAfterEffect.status).toBe("ok");
			expect(insertAfterEffect.inserted).toContain(
				"with an elderly or disabled member",
			);

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
			expect(insertBeforeEffect.status).toBe("ok");
			expect(insertBeforeEffect.inserted).toContain(
				"without an elderly or disabled member",
			);
			expect(insertBeforeEffect.inserted).toContain(
				"with an elderly or disabled member",
			);
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

			expect(effect.status).toBe("ok");
			expect(effect.inserted.length).toBeGreaterThan(0);
			expect(effect.inserted.join("\n")).toContain(
				"RESTRICTIONS ON INTERNET EXPENSES",
			);
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
