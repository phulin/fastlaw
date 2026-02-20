import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHighlightedSnippetMarkdown } from "../amended-snippet-markdown";
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
import { tp } from "./test-utils";

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
							text: tp("old"),
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

	it("applies StrikeInsert edits at each place when requested", () => {
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
							text: tp("2023"),
							eachPlaceItAppears: true,
						},
						insert: tp("2031"),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "For 2023 and 2023 only.",
			instructionText:
				'Section 1 is amended by striking "2023" each place it appears and inserting "2031".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("For 2031 and 2031 only.");
		expect(effect.segments[0]?.text).not.toContain("2023");
		expect(effect.replacements).toHaveLength(2);
		expect(
			effect.replacements?.every(
				(replacement) => replacement.deletedText === "2023",
			),
		).toBe(true);
	});

	it("applies Strike edits at each place when requested", () => {
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
							text: tp("x"),
							eachPlaceItAppears: true,
						},
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "x alpha x beta x",
			instructionText:
				'Section 1 is amended by striking "x" each place it appears.',
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe(" alpha  beta ");
		expect(effect.segments[0]?.text).not.toContain("x");
	});

	it("records partial apply failed items for no-match operations", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: { kind: SearchTargetKind.Text, text: tp("old") },
						insert: tp("new"),
					},
				},
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: { kind: SearchTargetKind.Text, text: tp("missing") },
						insert: tp("new"),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "old text",
			instructionText: "Section 1 is amended by striking and inserting.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.applySummary.partiallyApplied).toBe(true);
		expect(effect.applySummary.failedItems).toHaveLength(1);
		expect(effect.applySummary.failedItems[0]?.reasonKind).toBe("no_match");
		expect(effect.applySummary.failedItems[0]?.operationIndex).toBe(1);
	});

	it("records partial apply failed items for unresolved targets", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "z" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: tp("old") },
								insert: tp("new"),
							},
						},
					],
				},
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: { kind: SearchTargetKind.Text, text: tp("old") },
						insert: tp("new"),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "old text",
			instructionText: "Section 1 is amended by striking and inserting.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.applySummary.partiallyApplied).toBe(true);
		expect(effect.applySummary.failedItems).toHaveLength(1);
		expect(effect.applySummary.failedItems[0]?.reasonKind).toBe(
			"target_unresolved",
		);
		expect(effect.applySummary.failedItems[0]?.operationIndex).toBe(0);
	});

	it("applies Insert edits", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: { kind: UltimateEditKind.Insert, content: tp("new text") },
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

	it("formats multiline Insert edits as quoted block content", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: tp("(1) Alpha.\n(2) Beta."),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) Opening line.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain("\n> (1) Alpha.");
		expect(effect.segments[0]?.text).toContain("\n> (2) Beta.");
		expect(effect.inserted[0]).toContain("> (1) Alpha.");
	});

	it("formats scoped Rewrite edits with nested marker indentation", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "u" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.Rewrite,
								content: tp(
									[
										"(u) THRIFTY FOOD PLAN.—",
										"(1) IN GENERAL.—Alpha.",
										"(A) Beta.",
									].join("\n"),
								),
							},
						},
					],
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: [
				"**(t)** Existing text.",
				"**(u)** Old text.",
				"**(v)** Following text.",
			].join("\n"),
			instructionText: "Section 1(u) is amended to read as follows.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain("(u) THRIFTY FOOD PLAN.—");
		expect(effect.segments[0]?.text).toContain("\n> (1) IN GENERAL.—Alpha.");
		expect(effect.segments[0]?.text).toContain("\n> > (A) Beta.");
		expect(effect.inserted[0]).toContain("(u) THRIFTY FOOD PLAN.—");
		expect(effect.inserted[0]).toContain("> (1) IN GENERAL.—Alpha.");
	});

	it("keeps scoped structural replacements formatted and appends add-at-end blocks after sibling subparagraphs", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "2015",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Paragraph, label: "4" },
					children: [
						{
							type: SemanticNodeType.Scope,
							scope: { kind: ScopeKind.Subparagraph, label: "A" },
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.StrikeInsert,
										strike: {
											ref: {
												kind: ScopeKind.Clause,
												path: [{ kind: ScopeKind.Clause, label: "ii" }],
											},
										},
										insert: tp(
											"(ii) is in a noncontiguous State and has an unemployment rate that is at or above 1.5 times the national unemployment rate.",
										),
									},
								},
							],
						},
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.Insert,
								content: tp(
									[
										"(C) DEFINITION OF NONCONTIGUOUS STATE.—",
										"(i) IN GENERAL.—In this paragraph, the term 'noncontiguous State' means a State that is not 1 of the contiguous 48 States or the District of Columbia.",
										"(ii) EXCLUSIONS.—The term 'noncontiguous State' does not include Guam or the Virgin Islands of the United States.",
									].join("\n"),
								),
							},
						},
					],
				},
			],
		};

		const sectionBody = [
			"> > **(4)** **Waiver**",
			"",
			"> > > **(A)** **In general**",
			"",
			"> > > On the request of a State agency and with the support of the chief executive officer of the State, the Secretary may waive the applicability of paragraph (2) to any group of individuals in the State if the Secretary makes a determination that the area in which the individuals reside—",
			"",
			"> > > > **(i)** has an unemployment rate of over 10 percent; or",
			"",
			"> > > > **(ii)** does not have a sufficient number of jobs to provide employment for the individuals.",
			"",
			"> > > **(B)** **Report**",
			"",
			"> > > The Secretary shall report the basis for a waiver under subparagraph (A).",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/2015",
			sectionBody,
			instructionText: "",
		});

		expect(effect.status).toBe("ok");
		const rendered = buildHighlightedSnippetMarkdown(effect, 10_000);
		expect(rendered.markdown).toContain("> > **(4)** **Waiver**");
		expect(rendered.markdown).toContain("> > > **(B)** **Report**");
		expect(rendered.markdown).toContain(
			"> > > > (ii) is in a noncontiguous State and has an unemployment rate that is at or above 1.5 times the national unemployment rate.",
		);
		expect(rendered.markdown).toContain(
			"> > > > (ii) EXCLUSIONS.—The term 'noncontiguous State' does not include Guam or the Virgin Islands of the United States.",
		);
		expect(rendered.replacements.length).toBe(2);
		expect(
			rendered.replacements.some((item) =>
				item.deletedText.includes(
					"> > > > **(ii)** does not have a sufficient number of jobs to provide employment for the individuals.",
				),
			),
		).toBe(true);
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
						strike: { kind: SearchTargetKind.Text, text: tp("old") },
						insert: tp("new"),
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
					edit: { kind: UltimateEditKind.Insert, content: tp("NEW") },
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
						content: tp("Replacement text."),
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
						target: { kind: SearchTargetKind.Text, text: tp("alpha") },
						through: { kind: SearchTargetKind.Text, text: tp("beta") },
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
						insert: tp("new"),
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

	it("applies StrikeInsert structural target ranges", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: {
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
						insert: tp("(a) New first.\n(b) New second."),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) Old first.\n(b) Old second.\n(c) Keep.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain("(a) New first.");
		expect(effect.segments[0]?.text).toContain("(b) New second.");
		expect(effect.segments[0]?.text).toContain("(c) Keep.");
		expect(effect.segments[0]?.text).not.toContain("Old first");
		expect(effect.segments[0]?.text).not.toContain("Old second");
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
						content: tp("new"),
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
						content: tp("new"),
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
						content: tp("new"),
						before: { kind: SearchTargetKind.Text, text: tp("old") },
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
						content: tp("new"),
						after: { kind: SearchTargetKind.Text, text: tp("old") },
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
						content: tp("(1) New item."),
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
								content: tp("(2) Another item."),
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
		expect(byRefEffect.segments[0]?.text).toContain("(1) New item.");
		expect(byRestrictionEffect.status).toBe("ok");
		expect(byRestrictionEffect.segments[0]?.text).toContain(
			"(2) Another item.",
		);
	});

	it("applies add-at-end when target path only specifies the section", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: tp("(c) Newly added subsection."),
						atEndOf: {
							kind: ScopeKind.Section,
							path: [{ kind: ScopeKind.Section, label: "1" }],
						},
					},
				},
			],
		};

		const sectionBody = "(a) Alpha.\n(b) Beta.";
		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
			instructionText:
				"Section 1 is amended by adding at the end the following:",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain("(c) Newly added subsection.");
		expect(effect.debug.operationAttempts[0]?.hasExplicitTargetPath).toBe(
			false,
		);
	});

	it("appends add-at-end content after existing child markers within a target paragraph", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1359cc",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Paragraph, label: "2" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.Insert,
								content: tp(
									"(B) EXCEPTION.—If the Secretary makes an upward adjustment.",
								),
							},
						},
					],
				},
			],
		};

		const sectionBody = [
			"(2) Allocation to processors.",
			"(A) IN GENERAL.—Except as provided in subparagraph (B), in the case of any increase.",
			"(3) Carry-over of reductions.",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/1359cc",
			sectionBody,
			instructionText: "by adding at the end the following:",
		});

		expect(effect.status).toBe("ok");
		const result = effect.segments[0]?.text ?? "";
		const indexOfA = result.indexOf("(A) IN GENERAL");
		const indexOfB = result.indexOf("(B) EXCEPTION.—");
		const addAtEndAttempt = effect.debug.operationAttempts.find(
			(item) => item.operationType === "insert",
		);
		expect(indexOfA).toBeGreaterThanOrEqual(0);
		expect(indexOfB).toBeGreaterThanOrEqual(0);
		expect(addAtEndAttempt?.scopedRange?.preview).toContain("(A) IN GENERAL");
		expect(indexOfB).toBeGreaterThan(indexOfA);
	});

	it("does not widen strike-insert replacement to ancestor scope when replacing a single paragraph", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "9037",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "c" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: {
									ref: {
										kind: ScopeKind.Paragraph,
										path: [{ kind: ScopeKind.Paragraph, label: "2" }],
									},
								},
								insert: tp(
									"(2) VALUE OF ASSISTANCE.—The value of the assistance provided under paragraph (1) shall be—\n(A) for the period beginning on August 1, 2013, and ending on July 31, 2025, 3 cents per pound; and\n(B) beginning on August 1, 2025, 5 cents per pound.",
								),
							},
						},
					],
				},
			],
		};

		const sectionBody = [
			"**(c)** **RATE.**",
			"> **(1)** The value of the assistance under paragraph (1) shall be 3 cents per pound.",
			"> **(2)** The value of the assistance under paragraph (1) shall be 4 cents per pound.",
			"> **(3)** No overlap.",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/9037",
			sectionBody,
		});

		expect(effect.status).toBe("ok");
		expect(effect.changes[0]?.deleted).not.toContain("**(c)** **RATE.**");
		expect(effect.changes[0]?.deleted).not.toContain("> **(1)**");
		expect(effect.changes[0]?.deleted).toContain("> **(2)**");
		const result = effect.segments[0]?.text ?? "";
		expect(result).toContain("**(c)** **RATE.**");
		expect(result).toContain("> **(1)**");
		expect(result).toContain("> (2) VALUE OF ASSISTANCE.—");
		expect(result).toContain("5 cents per pound.\n> **(3)** No overlap.");
	});

	it("does not widen strike-insert replacement in unquoted hierarchy layouts", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "9037",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "c" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: {
									ref: {
										kind: ScopeKind.Paragraph,
										path: [{ kind: ScopeKind.Paragraph, label: "2" }],
									},
								},
								insert: tp(
									"(2) VALUE OF ASSISTANCE.—The value of the assistance provided under paragraph (1) shall be—\n(A) for the period beginning on August 1, 2013, and ending on July 31, 2025, 3 cents per pound; and\n(B) beginning on August 1, 2025, 5 cents per pound.",
								),
							},
						},
					],
				},
			],
		};

		const sectionBody = [
			"(b) QUOTA ENTRY PERIOD.",
			"(3) No overlap",
			"Notwithstanding paragraph (2), a quota period may not be established that overlaps an existing quota period or a special quota period established under subsection (a).",
			"(c) Economic adjustment assistance for textile mills",
			"(1) In general",
			"Subject to paragraph (2), the Secretary shall, on a monthly basis, make economic adjustment assistance available...",
			"(2) VALUE OF ASSISTANCE.—The value of the assistance provided under paragraph (1) shall be—",
			"(A) for the period beginning on August 1, 2013, and ending on July 31, 2025, 3 cents per pound; and",
			"(B) beginning on August 1, 2025, 5 cents per pound.",
			"(3) Allowable purposes",
			"Economic adjustment assistance under this subsection shall be made available only...",
		].join("\n\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/9037",
			sectionBody,
		});

		expect(effect.status).toBe("ok");
		expect(effect.changes[0]?.deleted).not.toContain(
			"(c) Economic adjustment assistance for textile mills",
		);
		expect(effect.changes[0]?.deleted).toContain(
			"(2) VALUE OF ASSISTANCE.—The value of the assistance provided under paragraph (1) shall be—",
		);
		const result = effect.segments[0]?.text ?? "";
		expect(result).toContain(
			"(c) Economic adjustment assistance for textile mills",
		);
		expect(result).toContain("(1) In general");
		expect(result).toContain("(3) Allowable purposes");
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
						strike: { kind: SearchTargetKind.Text, text: tp("old") },
						insert: tp("new"),
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
								strike: { kind: SearchTargetKind.Text, text: tp("old") },
								insert: tp("new"),
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
										strike: { kind: SearchTargetKind.Text, text: tp("old") },
										insert: tp("new"),
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
								strike: { kind: SearchTargetKind.Text, text: tp("old") },
								insert: tp("new"),
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
								strike: { kind: SearchTargetKind.Text, text: tp("old") },
								insert: tp("new"),
							},
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "old text. second sentence.");
		expect(effect.status).toBe("ok");
	});

	it("applies sentence-last location restriction", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: {
						kind: LocationRestrictionKind.SentenceLast,
					},
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: tp("old") },
								insert: tp("new"),
							},
						},
					],
				},
			],
		};
		const effect = applyVariant(tree, "First sentence old. Last sentence old.");
		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe(
			"First sentence old. Last sentence new.",
		);
	});

	it("applies matter-preceding as a true location restriction boundary", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: {
						kind: LocationRestrictionKind.MatterPreceding,
						ref: {
							kind: ScopeKind.Paragraph,
							path: [{ kind: ScopeKind.Paragraph, label: "2" }],
						},
					},
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: tp("old text") },
								insert: tp("new text"),
							},
						},
					],
				},
			],
		};

		const effect = applyVariant(
			tree,
			[
				"Intro old text.",
				"",
				"**(1)** Alpha.",
				"",
				"**(2)** old text in paragraph two.",
			].join("\n"),
		);

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain("Intro new text.");
		expect(effect.segments[0]?.text).toContain(
			"**(2)** old text in paragraph two.",
		);
	});

	it("applies matter-following as a true location restriction boundary", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: {
						kind: LocationRestrictionKind.MatterFollowing,
						ref: {
							kind: ScopeKind.Paragraph,
							path: [{ kind: ScopeKind.Paragraph, label: "1" }],
						},
					},
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: tp("old text") },
								insert: tp("new text"),
							},
						},
					],
				},
			],
		};

		const effect = applyVariant(
			tree,
			[
				"**(1)** old text in paragraph one.",
				"",
				"**(2)** old text in paragraph two.",
			].join("\n"),
		);

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain(
			"**(1)** old text in paragraph one.",
		);
		expect(effect.segments[0]?.text).toContain(
			"**(2)** new text in paragraph two.",
		);
	});

	it("resolves matter-preceding target when path omits intermediate levels", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "9034",
			children: [
				{
					type: SemanticNodeType.LocationRestriction,
					restriction: {
						kind: LocationRestrictionKind.MatterPreceding,
						ref: {
							kind: ScopeKind.Subparagraph,
							path: [
								{ kind: ScopeKind.Subsection, label: "b" },
								{ kind: ScopeKind.Subparagraph, label: "A" },
							],
						},
					},
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: { kind: SearchTargetKind.Text, text: tp("old text") },
								insert: tp("new text"),
							},
						},
					],
				},
			],
		};

		const effect = applyVariant(
			tree,
			[
				"**(b)** Intro old text for subsection b.",
				"",
				"> **(1)** Paragraph one lead-in.",
				"> > **(A)** old text in subparagraph A.",
			].join("\n"),
		);

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toContain(
			"**(b)** Intro new text for subsection b.",
		);
		expect(effect.segments[0]?.text).toContain(
			"> > **(A)** old text in subparagraph A.",
		);
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
										strike: { kind: SearchTargetKind.Text, text: tp("old") },
										insert: tp("new"),
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
										strike: { kind: SearchTargetKind.Text, text: tp("old") },
										insert: tp("new"),
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
						target: { kind: SearchTargetKind.Text, text: tp("old") },
					},
				},
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: tp("new"),
						after: { kind: SearchTargetKind.Text, text: tp("text") },
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
								target: { kind: SearchTargetKind.Text, text: tp("old") },
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
			"> > > (E) RESTRICTIONS ON INTERNET EXPENSES.—",
		);
	});
});
