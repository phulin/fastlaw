import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHandcraftedInstructionParser } from "../../scripts/handcrafted-instruction-parser";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import {
	type InstructionSemanticTree,
	SearchTargetKind,
	SemanticNodeType,
	UltimateEditKind,
} from "../amendment-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { parseFixtureParagraphs } from "./test-utils";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const HR1_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/hr1-abridged-output.txt",
);
const USC_2014_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014-pre.md",
);
const USC_2014_POST_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014.post.md",
);

describe("applyAmendmentEditTreeToSection", () => {
	it("applies strike-and-insert text edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: {
							kind: SearchTargetKind.Text,
							text: "old",
						},
						insert: "new",
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "This is old text.",
			rootQuery: [{ type: "section", val: "1" }],
			instructionText:
				'Section 1 is amended by striking "old" and inserting "new".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("This is new text.");
		expect(effect.deleted).toEqual(["old"]);
		expect(effect.inserted).toEqual(["new"]);
	});

	it("applies HR1 sec. 10103 and 10104 semantic trees against the USC 7/2014 markdown fixture", () => {
		const parser = createHandcraftedInstructionParser();
		const fixtureText = readFileSync(HR1_FIXTURE_PATH, "utf8");
		const paragraphs = parseFixtureParagraphs(fixtureText);
		const instructions = extractAmendatoryInstructions(paragraphs);
		const citations = [
			"7 U.S.C. 2014(e)(6)(C)(iv)(I)",
			"7 U.S.C. 2014(k)(4)",
			"7 U.S.C. 2014(e)(6)",
		];

		let sectionBody = readFileSync(USC_2014_PRE_FIXTURE_PATH, "utf8").trim();
		for (const citation of citations) {
			const instruction = instructions.find(
				(item) => item.uscCitation === citation,
			);
			if (!instruction) throw new Error(`Missing instruction for ${citation}`);
			const parsed = parser.parseInstructionFromLines(
				instruction.text.split("\n"),
				0,
			);
			if (!parsed)
				throw new Error(`Failed to parse instruction for ${citation}`);
			const translated = translateInstructionAstToEditTree(parsed.ast);
			expect(translated.issues).toEqual([]);

			const effect = applyAmendmentEditTreeToSection({
				tree: translated.tree,
				sectionPath: "/statutes/usc/section/7/2014",
				sectionBody,
				rootQuery: instruction.rootQuery,
				instructionText: instruction.text,
			});

			expect(effect.status).toBe("ok");
			sectionBody = effect.segments.map((segment) => segment.text).join("");
		}

		const expectedPost = readFileSync(
			USC_2014_POST_FIXTURE_PATH,
			"utf8",
		).trim();
		expect(sectionBody).toBe(expectedPost);
		expect(sectionBody).toContain(
			"households with an elderly or disabled member that received a payment",
		);
		expect(sectionBody).toContain(
			"to a household without an elderly or disabled member shall be considered money payable directly to the household.",
		);
		expect(sectionBody).toContain(
			"expense paid on behalf of a household with an elderly or disabled member under a State law",
		);
		expect(sectionBody).toContain(
			"> > > **(E)** **RESTRICTIONS ON INTERNET EXPENSES**",
		);
	});
});
