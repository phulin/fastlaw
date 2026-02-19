import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import {
	type InstructionSemanticTree,
	LocationRestrictionKind,
	ScopeKind,
	SearchTargetKind,
	SemanticNodeType,
	UltimateEditKind,
} from "../amendment-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const USC_2014_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014-pre.md",
);
const USC_2014_POST_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014-post.md",
);
interface IntegrationInstruction {
	citation: string;
	text: string;
}

const HR1_10103_10104_INSTRUCTIONS: IntegrationInstruction[] = [
	{
		citation: "7 U.S.C. 2014(e)(6)(C)(iv)(I)",
		text: "(a) STANDARD UTILITY ALLOWANCE.—Section 5(e)(6)(C)(iv)(I) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)(C)(iv)(I)) is amended by inserting “with an elderly or disabled member” after “households”.",
	},
	{
		citation: "7 U.S.C. 2014(k)(4)",
		text: `(b) THIRD-PARTY ENERGY ASSISTANCE PAYMENTS.—Section 5(k)(4) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(k)(4)) is amended—
(1) in subparagraph (A), by inserting “without an elderly or disabled member” before “shall be”; and
(2) in subparagraph (B), by inserting “with an elderly or disabled member” before “under a State law”.`,
	},
	{
		citation: "7 U.S.C. 2014(e)(6)",
		text: `Section 5(e)(6) of the Food and Nutrition Act of 2008 (7 U.S.C. 2014(e)(6)) is amended by adding at the end the following:
“(E) RESTRICTIONS ON INTERNET EXPENSES.—Any service fee associated with internet connection shall not be used in computing the excess shelter expense deduction under this paragraph.”.`,
	},
];

describe("applyAmendmentEditTreeToSection unit", () => {
	it("applies Strike edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Strike,
						target: {
							kind: SearchTargetKind.Text,
							text: "old",
						},
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "This is old text.",
			instructionText: 'Section 1 is amended by striking "old".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("This is  text.");
		expect(effect.deleted).toEqual(["old"]);
		expect(effect.inserted).toEqual([]);
	});

	it("applies Insert edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: { kind: UltimateEditKind.Insert, content: "new text" },
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "This is old text.",
			instructionText: 'Section 1 is amended by inserting "new text".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("This is old text.\nnew text");
		expect(effect.deleted).toEqual([]);
		expect(effect.inserted).toEqual(["\nnew text"]);
	});

	it("applies StrikeInsert edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: { kind: SearchTargetKind.Text, text: "old" },
						insert: "new",
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "This is old text.",
			instructionText:
				'Section 1 is amended by striking "old" and inserting "new".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("This is new text.");
		expect(effect.deleted).toEqual(["old"]);
		expect(effect.inserted).toEqual(["new"]);
	});

	it("does not use tree targetScopePath as fallback root scope", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetScopePath: [
				{ kind: ScopeKind.Section, label: "1" },
				{ kind: ScopeKind.Subsection, label: "a" },
				{ kind: ScopeKind.Paragraph, label: "2" },
			],
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: { kind: UltimateEditKind.Insert, content: "NEW" },
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) Intro.\n(1) One.\n(2) Two.",
			instructionText: 'Section 1(a)(2) is amended by inserting "NEW".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.debug.operationAttempts[0]?.targetPath).toBeNull();
		expect(effect.debug.operationAttempts[0]?.hasExplicitTargetPath).toBe(
			false,
		);
	});

	it("applies Rewrite edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Rewrite,
						content: "Replacement text.",
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "Original text.",
			instructionText: "Section 1 is amended to read as follows.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("Replacement text.");
	});

	it("applies Redesignate edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Redesignate,
						mappings: [
							{
								from: {
									kind: ScopeKind.Paragraph,
									path: [{ kind: ScopeKind.Paragraph, label: "a" }],
								},
								to: {
									kind: ScopeKind.Paragraph,
									path: [{ kind: ScopeKind.Paragraph, label: "b" }],
								},
							},
						],
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) Original text.",
			instructionText: "Section 1 redesignates paragraph (a) as (b).",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("(b) Original text.");
	});

	it("applies Move edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Move,
						from: [
							{
								kind: ScopeKind.Paragraph,
								path: [{ kind: ScopeKind.Paragraph, label: "a" }],
							},
						],
						after: {
							kind: ScopeKind.Paragraph,
							path: [{ kind: ScopeKind.Paragraph, label: "b" }],
						},
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) First.\n(b) Second.",
			instructionText: "Move paragraph (a) to appear after paragraph (b).",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("(b) Second.\n(a) First.");
	});

	it("applies Strike through-variants", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Strike,
						target: { kind: SearchTargetKind.Text, text: "alpha" },
						through: { kind: SearchTargetKind.Text, text: "beta" },
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "alpha beta gamma",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("gamma");
	});

	it("applies StrikeInsert non-text targets", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: {
							ref: {
								kind: ScopeKind.Paragraph,
								path: [{ kind: ScopeKind.Paragraph, label: "a" }],
							},
						},
						insert: "new",
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) old",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain("new");
		expect(effect.segments[0]?.text).not.toContain("old");
	});

	it("applies Insert before/after non-text anchors", () => {
		const beforeTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: "new",
						before: {
							ref: {
								kind: ScopeKind.Paragraph,
								path: [{ kind: ScopeKind.Paragraph, label: "a" }],
							},
						},
					},
				},
			],
		};
		const afterTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: "new",
						after: {
							ref: {
								kind: ScopeKind.Paragraph,
								path: [{ kind: ScopeKind.Paragraph, label: "a" }],
							},
						},
					},
				},
			],
		};

		const beforeEffect = applyAmendmentEditTreeToSection({
			tree: beforeTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) old",
		});
		const afterEffect = applyAmendmentEditTreeToSection({
			tree: afterTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) old",
		});

		expect(beforeEffect.status).toBe("ok");
		expect(beforeEffect.segments[0]?.text).toBe("new\n(a) old");
		expect(afterEffect.status).toBe("ok");
		expect(afterEffect.segments[0]?.text).toBe("(a) old\nnew");
	});

	it("applies Insert before and after text anchors", () => {
		const beforeTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: "new",
						before: { kind: SearchTargetKind.Text, text: "old" },
					},
				},
			],
		};
		const afterTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: "new",
						after: { kind: SearchTargetKind.Text, text: "old" },
					},
				},
			],
		};

		const beforeEffect = applyAmendmentEditTreeToSection({
			tree: beforeTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "old text",
		});
		const afterEffect = applyAmendmentEditTreeToSection({
			tree: afterTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "old text",
		});

		expect(beforeEffect.status).toBe("ok");
		expect(beforeEffect.segments[0]?.text).toBe("new old text");
		expect(afterEffect.status).toBe("ok");
		expect(afterEffect.segments[0]?.text).toBe("old new text");
	});

	it("applies Insert at-end variants (atEndOf and at-end location)", () => {
		const byRefTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: "(1) New item.",
						atEndOf: {
							kind: ScopeKind.Paragraph,
							path: [{ kind: ScopeKind.Paragraph, label: "a" }],
						},
					},
				},
			],
		};
		const byRestrictionTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: { kind: LocationRestrictionKind.AtEnd },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.Insert,
								content: "(2) Another item.",
							},
						},
					],
				},
			],
		};
		const sectionBody = "(a) Alpha.";

		const byRefEffect = applyAmendmentEditTreeToSection({
			tree: byRefTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
		});
		const byRestrictionEffect = applyAmendmentEditTreeToSection({
			tree: byRestrictionTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
			instructionText: "by adding at the end the following:",
		});

		expect(byRefEffect.status).toBe("ok");
		expect(byRefEffect.segments[0]?.text).toContain("**(1)** New item.");
		expect(byRestrictionEffect.status).toBe("ok");
		expect(byRestrictionEffect.segments[0]?.text).toContain(
			"**(2)** Another item.",
		);
	});
});

describe("applyAmendmentEditTreeToSection unit tree-shape coverage", () => {
	const applyVariant = (tree: InstructionSemanticTree, sectionBody: string) =>
		applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
		});

	it("covers sample #1: sub_head-only variant -> root edit node", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: { kind: SearchTargetKind.Text, text: "old" },
						insert: "new",
					},
				},
			],
		};
		const effect = applyVariant(tree, "old text");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #2: sub_head+subscope variant -> scope wrapper", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "a" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: "old" },
								insert: "new",
							},
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "(a) old text");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #3: subscope with of-tail -> merged nested scopes", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "a" },
					children: [
						{
							type: SemanticNodeType.Scope,
							scope: { kind: ScopeKind.Paragraph, label: "1" },
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.StrikeInsert,
										strike: { kind: SearchTargetKind.Text, text: "old" },
										insert: "new",
									},
								},
							],
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "(a)\n> **(1)** old text");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #4: subscope_plural variant -> in-location (plural refs)", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: {
						kind: LocationRestrictionKind.In,
						refs: [
							{
								kind: ScopeKind.Subsection,
								path: [{ kind: ScopeKind.Subsection, label: "a" }],
							},
							{
								kind: ScopeKind.Subsection,
								path: [{ kind: ScopeKind.Subsection, label: "b" }],
							},
						],
					},
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: "old" },
								insert: "new",
							},
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "(a) old\n(b) old\n(c) old");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #5: sub_head+text_location variant -> sentence-ordinal restriction", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: {
						kind: LocationRestrictionKind.SentenceOrdinal,
						ordinal: 1,
					},
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: "old" },
								insert: "new",
							},
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "old text. second sentence.");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #6: sub_head+subscope+text_location variant -> nested wrappers", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "a" },
					children: [
						{
							type: SemanticNodeType.LocationRestriction,
							restriction: {
								kind: LocationRestrictionKind.SentenceOrdinal,
								ordinal: 1,
							},
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.StrikeInsert,
										strike: { kind: SearchTargetKind.Text, text: "old" },
										insert: "new",
									},
								},
							],
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "(a) old text. second sentence.");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #7: subinstruction recursion variant -> nested scopes", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "a" },
					children: [
						{
							type: SemanticNodeType.Scope,
							scope: { kind: ScopeKind.Clause, label: "i" },
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.StrikeInsert,
										strike: { kind: SearchTargetKind.Text, text: "old" },
										insert: "new",
									},
								},
							],
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "(a)\n> **(i)** old text");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #8: subinstruction alt (sub_id + edits) -> direct edit list shape", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Strike,
						target: { kind: SearchTargetKind.Text, text: "old" },
					},
				},
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: "new",
						after: { kind: SearchTargetKind.Text, text: "text" },
					},
				},
			],
		};
		const effect = applyVariant(tree, "old text");
		expect(effect.status).toBe("ok");
	});

	it("covers sample #9: subscope with sub_amended_by annotation -> same scope shape", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Paragraph, label: "1" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.Strike,
								target: { kind: SearchTargetKind.Text, text: "old" },
							},
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "(1) old text");
		expect(effect.status).toBe("ok");
	});
});

describe("applyAmendmentEditTreeToSection integration", () => {
	it("applies HR1 sec. 10103 and 10104 semantic trees against the USC 7/2014 markdown fixture", () => {
		const parser = createHandcraftedInstructionParser();
		let sectionBody = readFileSync(USC_2014_PRE_FIXTURE_PATH, "utf8").trim();
		for (const instruction of HR1_10103_10104_INSTRUCTIONS) {
			const parsed = parser.parseInstructionFromLines(
				instruction.text.split("\n"),
				0,
			);
			if (!parsed)
				throw new Error(
					`Failed to parse instruction for ${instruction.citation}`,
				);
			const translated = translateInstructionAstToEditTree(parsed.ast);
			expect(translated.issues).toEqual([]);

			const effect = applyAmendmentEditTreeToSection({
				tree: translated.tree,
				sectionPath: "/statutes/usc/section/7/2014",
				sectionBody,
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
