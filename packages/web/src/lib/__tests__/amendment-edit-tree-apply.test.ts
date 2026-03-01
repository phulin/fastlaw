import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { buildCanonicalDocument } from "../amendment-document-model";
import { applyPlannedPatchesTransaction } from "../amendment-edit-apply-transaction";
import type {
	CanonicalDocument,
	PlannedPatch,
	ResolvedInstructionOperation,
} from "../amendment-edit-engine-types";
import { planEdits } from "../amendment-edit-planner";
import {
	InnerLocationTargetKind,
	type InstructionSemanticTree,
	LocationRestrictionKind,
	PunctuationKind,
	ScopeKind,
	SearchTargetKind,
	SemanticNodeType,
	type TargetScopeSegment,
	UltimateEditKind,
} from "../amendment-edit-tree";
import {
	applyAmendmentEditTreeToSection,
	walkTree,
} from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";
import { ParagraphRange } from "../types";
import {
	createParagraph,
	expectEffectToContainMarkedText,
	tp,
} from "./test-utils";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const USC_2014_PRE_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/usc-7-2014-pre.md",
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
		expectEffectToContainMarkedText(effect, "This is~~ old~~ text.");
		expect(effect.deleted).toEqual([" old"]);
		expect(effect.inserted).toEqual([]);
	});

	it("plans structural and-list strikes as discrete deletions", () => {
		const model = buildCanonicalDocument(
			"(a) Alpha.\n(b) Bravo.\n(c) Charlie.\n(d) Delta.\n(e) Echo.",
		);
		const topLevelNodes = [...model.nodesById.values()].filter(
			(node) => node.path.length === 1,
		);
		const bId =
			topLevelNodes.find(
				(node) => node.label === "b" && node.kind === "subsection",
			)?.id ?? null;
		const dId =
			topLevelNodes.find(
				(node) => node.label === "d" && node.kind === "subsection",
			)?.id ?? null;
		if (!bId || !dId) throw new Error("Expected subsection targets.");

		const operation: ResolvedInstructionOperation = {
			operationIndex: 0,
			nodeText: "by striking subsections (b) and (d)",
			originalNodeText: null,
			scopeContextTexts: [],
			edit: {
				kind: UltimateEditKind.Strike,
				target: {
					refs: [
						{
							kind: ScopeKind.Subsection,
							path: [{ kind: ScopeKind.Subsection, label: "b" }],
						},
						{
							kind: ScopeKind.Subsection,
							path: [{ kind: ScopeKind.Subsection, label: "d" }],
						},
					],
				},
				structuralMode: "discrete",
			},
			addAtEnd: false,
			redesignateMappingIndex: 0,
			sentenceOrdinal: null,
			atEndOnly: false,
			hasMatterPrecedingTarget: false,
			hasMatterFollowingTarget: false,
			matterPrecedingRefKind: null,
			matterPrecedingRefLabel: null,
			matterFollowingRefKind: null,
			matterFollowingRefLabel: null,
			hasExplicitTargetPath: true,
			targetPathText: "subsection:b",
			resolvedTargetId: bId,
			resolvedMatterPrecedingTargetId: null,
			resolvedMatterFollowingTargetId: null,
			resolvedThroughTargetId: dId,
			structuralStrikeMode: "discrete",
			resolvedStructuralTargetIds: [bId, dId],
			resolvedAnchorTargetId: null,
			resolvedMoveFromIds: [],
			resolvedMoveAnchorId: null,
		};

		const { patches } = planEdits(model, [operation], []);
		expect(patches).toHaveLength(2);
		expect(patches.map((patch) => patch.deletedPlain)).toEqual([
			"(b) Bravo.\n",
			"(d) Delta.\n",
		]);
	});

	it("plans structural through-range strikes as contiguous deletion", () => {
		const model = buildCanonicalDocument(
			"(a) Alpha.\n(b) Bravo.\n(c) Charlie.\n(d) Delta.\n(e) Echo.",
		);
		const topLevelNodes = [...model.nodesById.values()].filter(
			(node) => node.path.length === 1,
		);
		const bId =
			topLevelNodes.find(
				(node) => node.label === "b" && node.kind === "subsection",
			)?.id ?? null;
		const dId =
			topLevelNodes.find(
				(node) => node.label === "d" && node.kind === "subsection",
			)?.id ?? null;
		if (!bId || !dId) throw new Error("Expected subsection targets.");

		const operation: ResolvedInstructionOperation = {
			operationIndex: 0,
			nodeText: "by striking subsections (b) through (d)",
			originalNodeText: null,
			scopeContextTexts: [],
			edit: {
				kind: UltimateEditKind.Strike,
				target: {
					refs: [
						{
							kind: ScopeKind.Subsection,
							path: [{ kind: ScopeKind.Subsection, label: "b" }],
						},
						{
							kind: ScopeKind.Subsection,
							path: [{ kind: ScopeKind.Subsection, label: "c" }],
						},
						{
							kind: ScopeKind.Subsection,
							path: [{ kind: ScopeKind.Subsection, label: "d" }],
						},
					],
				},
				structuralMode: "range",
			},
			addAtEnd: false,
			redesignateMappingIndex: 0,
			sentenceOrdinal: null,
			atEndOnly: false,
			hasMatterPrecedingTarget: false,
			hasMatterFollowingTarget: false,
			matterPrecedingRefKind: null,
			matterPrecedingRefLabel: null,
			matterFollowingRefKind: null,
			matterFollowingRefLabel: null,
			hasExplicitTargetPath: true,
			targetPathText: "subsection:b",
			resolvedTargetId: bId,
			resolvedMatterPrecedingTargetId: null,
			resolvedMatterFollowingTargetId: null,
			resolvedThroughTargetId: dId,
			structuralStrikeMode: "range",
			resolvedStructuralTargetIds: [bId, dId],
			resolvedAnchorTargetId: null,
			resolvedMoveFromIds: [],
			resolvedMoveAnchorId: null,
		};

		const { patches } = planEdits(model, [operation], []);
		expect(patches).toHaveLength(1);
		expect(patches[0]?.deletedPlain).toBe(
			"(b) Bravo.\n(c) Charlie.\n(d) Delta.\n",
		);
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
		expectEffectToContainMarkedText(
			effect,
			"For ~~2023~~++2031++ and ~~2023~~++2031++ only.",
		);
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
		expectEffectToContainMarkedText(effect, "~~x~~ alpha ~~x~~ beta ~~x~~");
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

	it("does not use placeholder anchor text for unresolved structural insert-after", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: tp(
							"(89) provide that the State shall comply with the eligibility verification requirements.",
						),
						after: {
							ref: {
								kind: ScopeKind.Paragraph,
								path: [{ kind: ScopeKind.Paragraph, label: "88" }],
							},
						},
					},
				},
			],
		};

		const sectionBody =
			"(a) who are optional targeted low-income children described in section 1396d(u)(2)(B).";
		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
		});

		expect(effect.status).toBe("unsupported");
		expect(effect.renderModel.plainText).toBe(sectionBody);
		expect(effect.applySummary.partiallyApplied).toBe(true);
		expect(effect.applySummary.failedItems).toHaveLength(1);
		expect(effect.applySummary.failedItems[0]?.reasonKind).toBe(
			"target_unresolved",
		);
	});

	it("fails when instruction amends a USC note citation", () => {
		const parser = createHandcraftedInstructionParser();
		const instructionLines = [
			"Section 105(f)(1) of the Gulf of Mexico Energy Security Act of 2006 (43 U.S.C. 1331 note; Public Law 109–432) is amended—",
			"(1) in subsection (f), by striking “shared among” and inserting “allocated among”.",
		];
		const parsed = parser.parseInstructionFromLines(instructionLines, 0);
		expect(parsed).toBeTruthy();
		if (!parsed) return;

		const translated = translateInstructionAstToEditTree(parsed.ast);
		expect(translated.issues).toEqual([]);
		expect(translated.tree.targetScopePath).toEqual([
			{ kind: "code_reference", label: "43 U.S.C." },
			{ kind: ScopeKind.Section, label: "1331" },
			{ kind: "note_reference", label: "note" },
		]);

		const effect = applyAmendmentEditTreeToSection({
			tree: translated.tree,
			sectionPath: "/statutes/usc/section/43/1331",
			sectionBody: "Revenue from leases shall be shared among States.",
			instructionText: instructionLines.join("\n"),
		});

		expect(effect.status).toBe("unsupported");
		expect(effect.changes).toHaveLength(0);
		expect(effect.debug.failureReason).toBe("target_unresolved");
		expect(effect.applySummary.failedItems[0]?.reasonKind).toBe(
			"target_unresolved",
		);
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
		expect(effect.renderModel.plainText).toBe("This is old text.\nnew text");
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
		expect(effect.renderModel.plainText).toContain("\n(1) Alpha.");
		expect(effect.renderModel.plainText).toContain("\n(2) Beta.");
		expect(effect.inserted[0]).toContain("(1) Alpha.");
	});

	it.fails("reduces PDF-derived indentation levels by one for inserted block content", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: {
							text: "(A) Alpha.",
							sourceLocation: new ParagraphRange(
								[createParagraph("(A) Alpha.", { level: 3 })],
								0,
								10,
							),
						},
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
		expect(effect.inserted[0]).toContain("> > (A) Alpha.");
		expect(effect.inserted[0]).not.toContain("> > > (A) Alpha.");
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
		expect(effect.renderModel.plainText).toContain("(u) Thrifty food plan");
		expect(effect.renderModel.plainText).toContain("\n(1) In general\nAlpha.");
		expect(effect.renderModel.plainText).toContain("\n(A) Beta.");
		expect(effect.inserted[0]).toContain("(u) Thrifty food plan");
		expect(effect.inserted[0]).toContain("(1) In general\nAlpha.");
		const strongTexts = effect.renderModel.spans
			.filter((span) => span.type === "strong")
			.map((span) => effect.renderModel.plainText.slice(span.start, span.end));
		expect(strongTexts).toContain("(u)");
		expect(strongTexts).toContain("Thrifty food plan");
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
		expect(effect.renderModel.plainText).toContain("(4) Waiver");
		expect(effect.renderModel.plainText).toContain("(B) Report");
		expect(effect.renderModel.plainText).toContain(
			"(ii) is in a noncontiguous State and has an unemployment rate that is at or above 1.5 times the national unemployment rate.",
		);
		expect(effect.renderModel.plainText).toContain(
			"(ii) Exclusions\nThe term 'noncontiguous State' does not include Guam or the Virgin Islands of the United States.",
		);
	});

	it("splits mixed-case marker headings on .— into heading lines with strong spans", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1905",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Rewrite,
						content: tp(
							[
								"(1) Premiums.—Beginning October 1, 2028, the State plan shall provide...",
								"(A) In general.—Subject to subparagraph (B), the State plan shall provide...",
								"(i) Exclusion of certain services.—In no case may a deduction be imposed...",
							].join("\n"),
						),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/42/1905",
			sectionBody: "(k) placeholder",
			instructionText: "Section 1905 is amended to read as follows.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"(1) Premiums\nBeginning October 1, 2028, the State plan shall provide...",
		);
		expect(effect.renderModel.plainText).toContain(
			"(A) In general\nSubject to subparagraph (B), the State plan shall provide...",
		);
		expect(effect.renderModel.plainText).toContain(
			"(i) Exclusion of certain services\nIn no case may a deduction be imposed...",
		);

		const strongTexts = effect.renderModel.spans
			.filter((span) => span.type === "strong")
			.map((span) => effect.renderModel.plainText.slice(span.start, span.end));
		expect(strongTexts).toContain("Premiums");
		expect(strongTexts).toContain("In general");
		expect(strongTexts).toContain("Exclusion of certain services");
	});

	it("does not auto-bold marker body text when marker line does not use .—", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1905",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Rewrite,
						content: tp(
							[
								"(1) Premiums",
								"Beginning October 1, 2028, the State plan shall provide...",
							].join("\n"),
						),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/42/1905",
			sectionBody: "(k) placeholder",
			instructionText: "Section 1905 is amended to read as follows.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"(1) Premiums\nBeginning October 1, 2028, the State plan shall provide...",
		);

		const strongTexts = effect.renderModel.spans
			.filter((span) => span.type === "strong")
			.map((span) => effect.renderModel.plainText.slice(span.start, span.end));
		expect(strongTexts).toContain("(1)");
		expect(strongTexts).not.toContain("Premiums");
	});

	it("splits inline structural marker transitions into separate paragraphs", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1905",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Rewrite,
						content: tp(
							[
								"(I) In general.—Except as provided in subclause (II), in no case may a deduction exceed $35. (II) Special rules for prescription drugs.—In no case may a deduction for a prescription drug exceed the limit.",
							].join("\n"),
						),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/42/1905",
			sectionBody: "(k) placeholder",
			instructionText: "Section 1905 is amended to read as follows.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"(I) In general\nExcept as provided in subclause (II), in no case may a deduction exceed $35.",
		);
		expect(effect.renderModel.plainText).toContain(
			"(II) Special rules for prescription drugs\nIn no case may a deduction for a prescription drug exceed the limit.",
		);
	});

	it("starts a new paragraph for a same-indent marker heading after body text", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1905",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Rewrite,
						content: tp(
							[
								"(I) In general.—Except as provided in subclause (II), in no case may a deduction exceed $35.",
								"In no case may a deduction for a prescription drug exceed the limit under paragraph (2)(A)(i).",
								"(II) Special rules for prescription drugs.—In no case may a deduction for a prescription drug exceed the applicable limit.",
							].join("\n"),
						),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/42/1905",
			sectionBody: "(k) placeholder",
			instructionText: "Section 1905 is amended to read as follows.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"paragraph (2)(A)(i).\n(II) Special rules for prescription drugs",
		);
		expect(effect.renderModel.plainText).toContain(
			"(II) Special rules for prescription drugs\nIn no case may a deduction for a prescription drug exceed the applicable limit.",
		);
	});

	it("does not treat non-structural parenthetical insertions as marker headings", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1396o",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: { kind: SearchTargetKind.Text, text: tp("individuals") },
						insert: tp(
							"individuals (other than, beginning October 1, 2028, specified individuals (as defined in subsection (k)(3)))",
						),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/42/1396o",
			sectionBody:
				"in the case of individuals described in subparagraph (A) or (E)(i)",
			instructionText: "Section 1396o is amended by striking and inserting.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"individuals (other than, beginning October 1, 2028, specified individuals (as defined in subsection (k)(3))) described",
		);
		const strongTexts = effect.renderModel.spans
			.filter((span) => span.type === "strong")
			.map((span) => effect.renderModel.plainText.slice(span.start, span.end));
		expect(
			strongTexts.some((text) =>
				text.includes("other than, beginning October"),
			),
		).toBe(false);
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
		expectEffectToContainMarkedText(effect, "This is ~~old~~++new++ text.");
		expect(effect.deleted).toEqual(["old"]);
		expect(effect.inserted).toEqual(["new"]);
	});

	it("applies subsection heading strike-insert without deleting subsection body", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "455",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "f" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.StrikeInsert,
								strike: {
									inner: {
										kind: InnerLocationTargetKind.SubsectionHeading,
									},
								},
								insert: tp("DEFERMENT; FORBEARANCE"),
							},
						},
					],
				},
			],
		};

		const sectionBody = [
			"(e) Existing subsection.",
			"(f) ECONOMIC HARDSHIP AND UNEMPLOYMENT DEFERMENTS.—The Secretary may grant deferment under this subsection.",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/20/1087e",
			sectionBody,
		});

		expect(effect.status).toBe("ok");
		expectEffectToContainMarkedText(
			effect,
			"(f) ~~ECONOMIC HARDSHIP AND UNEMPLOYMENT DEFERMENTS.~~++DEFERMENT; FORBEARANCE++—The Secretary may grant deferment under this subsection.",
		);
		expect(effect.renderModel.plainText).toContain(
			"The Secretary may grant deferment under this subsection.",
		);
	});

	it("applies before subsection heading location restriction", () => {
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
								kind: LocationRestrictionKind.Before,
								target: {
									kind: InnerLocationTargetKind.SubsectionHeading,
								},
							},
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.Strike,
										target: {
											kind: SearchTargetKind.Text,
											text: tp("(a)"),
										},
									},
								},
							],
						},
					],
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) FIRST HEADING—Body text.",
		});

		expect(effect.status).toBe("ok");
		expectEffectToContainMarkedText(effect, "~~(a)~~ FIRST HEADING—Body text.");
	});

	it("applies after subsection heading location restriction", () => {
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
								kind: LocationRestrictionKind.After,
								target: {
									kind: InnerLocationTargetKind.SubsectionHeading,
								},
							},
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.Strike,
										target: {
											kind: SearchTargetKind.Text,
											text: tp("Body"),
										},
									},
								},
							],
						},
					],
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) FIRST HEADING—Body text.",
		});

		expect(effect.status).toBe("ok");
		expectEffectToContainMarkedText(effect, "(a) FIRST HEADING—~~Body~~ text.");
	});

	it("applies matter-preceding edits in subsection introduction instead of subsection heading", () => {
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
								kind: LocationRestrictionKind.MatterPreceding,
								ref: {
									kind: ScopeKind.Paragraph,
									path: [{ kind: ScopeKind.Paragraph, label: "1" }],
								},
							},
							children: [
								{
									type: SemanticNodeType.Edit,
									edit: {
										kind: UltimateEditKind.Insert,
										content: tp(
											" (other than, beginning October 1, 2028, specified individuals)",
										),
										after: {
											kind: SearchTargetKind.Text,
											text: tp("individuals"),
										},
									},
								},
							],
						},
					],
				},
			],
		};

		const sectionBody = [
			"**(a)** **Imposition of certain charges under plan in case of individuals**",
			"",
			"Subject to this subsection, the State plan shall provide that in the case of individuals described in subparagraph (A), no enrollment fee shall be imposed.",
			"",
			"> **(1)** No enrollment fee.",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"(a) Imposition of certain charges under plan in case of individuals",
		);
		expect(effect.renderModel.plainText).toContain(
			"case of individuals (other than, beginning October 1, 2028, specified individuals) described in subparagraph (A)",
		);
	});

	it("inserts boundary spaces consistently for parenthetical insertions", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: tp("(other than, beginning October 1, 2028)"),
						after: {
							kind: SearchTargetKind.Text,
							text: tp("individuals"),
						},
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "in the case of individuals described in subparagraph (A)",
			instructionText:
				'Section 1 is amended by inserting "(other than, beginning October 1, 2028)" after "individuals".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.renderModel.plainText).toContain(
			"individuals (other than, beginning October 1, 2028) described",
		);
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
		expectEffectToContainMarkedText(
			effect,
			"~~Original text.~~++Replacement text.++",
		);
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
		expectEffectToContainMarkedText(effect, "~~(a)~~++(b)++ Original text.");
	});

	it("applies redesignation through-ranges without retargeting the same node repeatedly", () => {
		const fromLabels = [
			"H",
			"I",
			"J",
			"K",
			"L",
			"M",
			"N",
			"O",
			"P",
			"Q",
			"R",
			"S",
			"T",
			"U",
		];
		const toLabels = [
			"I",
			"J",
			"K",
			"L",
			"M",
			"N",
			"O",
			"P",
			"Q",
			"R",
			"S",
			"T",
			"U",
			"V",
		];
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Redesignate,
						mappings: fromLabels.map((from, index) => ({
							from: {
								kind: ScopeKind.Paragraph,
								path: [{ kind: ScopeKind.Paragraph, label: from }],
							},
							to: {
								kind: ScopeKind.Paragraph,
								path: [
									{ kind: ScopeKind.Paragraph, label: toLabels[index] ?? from },
								],
							},
						})),
					},
				},
			],
		};

		const sectionBody = [
			"(A) A",
			"(B) B",
			"(C) C",
			"(D) D",
			"(E) E",
			"(F) F",
			"(G) G",
			"(H) H",
			"(I) I",
			"(J) J",
			"(K) K",
			"(L) L",
			"(M) M",
			"(N) N",
			"(O) O",
			"(P) P",
			"(Q) Q",
			"(R) R",
			"(S) S",
			"(T) T",
			"(U) U",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
			instructionText:
				"Section 1 is amended by redesignating paragraphs (H) through (U) as paragraphs (I) through (V), respectively.",
		});
		expect(effect.status).toBe("ok");
		expect(effect.deleted).toEqual([
			"(H)",
			"(I)",
			"(J)",
			"(K)",
			"(L)",
			"(M)",
			"(N)",
			"(O)",
			"(P)",
			"(Q)",
			"(R)",
			"(S)",
			"(T)",
			"(U)",
		]);
		expect(effect.inserted).toEqual([
			"(I)",
			"(J)",
			"(K)",
			"(L)",
			"(M)",
			"(N)",
			"(O)",
			"(P)",
			"(Q)",
			"(R)",
			"(S)",
			"(T)",
			"(U)",
			"(V)",
		]);
	});

	it("applies insert-after alongside redesignation in the same subinstruction block", () => {
		const parser = createHandcraftedInstructionParser();
		const instruction = `Section 1 of title 10, United States Code, is amended—
(A) by redesignating subparagraphs (H) through (U) as subparagraphs (I) through (V), respectively; and
(B) by inserting after subparagraph (G) the following new subparagraph:
“(H) Added.”.`;
		const parsed = parser.parseInstructionFromLines(instruction.split("\n"), 0);
		if (!parsed) throw new Error("Expected instruction to parse.");
		const translated = translateInstructionAstToEditTree(parsed.ast);
		expect(translated.issues).toEqual([]);
		const queue = [...translated.tree.children];
		const edits: UltimateEditKind[] = [];
		let insertContent: string | null = null;
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) continue;
			if (current.type === SemanticNodeType.Edit) {
				edits.push(current.edit.kind);
				if (current.edit.kind === UltimateEditKind.Insert) {
					insertContent = current.edit.content.text;
				}
				continue;
			}
			queue.push(...current.children);
		}
		expect(edits).toContain(UltimateEditKind.Redesignate);
		expect(edits).toContain(UltimateEditKind.Insert);
		expect(insertContent).toContain("(H) Added.");

		const sectionBody = [
			"(A) A",
			"(B) B",
			"(C) C",
			"(D) D",
			"(E) E",
			"(F) F",
			"(G) G",
			"(H) H",
			"(I) I",
			"(J) J",
			"(K) K",
			"(L) L",
			"(M) M",
			"(N) N",
			"(O) O",
			"(P) P",
			"(Q) Q",
			"(R) R",
			"(S) S",
			"(T) T",
			"(U) U",
		].join("\n");
		const effect = applyAmendmentEditTreeToSection({
			tree: translated.tree,
			sectionPath: "/statutes/usc/section/10/1",
			sectionBody,
			instructionText: instruction,
		});
		expect(effect.status).toBe("ok");
		expect(effect.applySummary.failedItems).toEqual([]);
		expect(effect.renderModel.plainText).toContain("(H) Added.");
		const paragraphTexts = effect.renderModel.spans
			.filter((span) => span.type === "paragraph")
			.sort((left, right) => left.start - right.start || left.end - right.end)
			.map((span) => effect.renderModel.plainText.slice(span.start, span.end));
		expect(paragraphTexts.some((text) => text.includes("(H) Added."))).toBe(
			true,
		);
		expect(paragraphTexts.some((text) => text.includes("(I)"))).toBe(true);
		expect(paragraphTexts.length).toBeGreaterThan(1);
		const insertedHSpan = effect.renderModel.spans.find(
			(span) =>
				span.type === "insertion" &&
				effect.renderModel.plainText
					.slice(span.start, span.end)
					.includes("(H) Added."),
		);
		const oldHDeletionSpan = effect.renderModel.spans.find(
			(span) =>
				span.type === "deletion" &&
				effect.renderModel.plainText.slice(span.start, span.end) === "(H)",
		);
		expect(insertedHSpan).toBeDefined();
		expect(oldHDeletionSpan).toBeDefined();
		expect(insertedHSpan?.start ?? Number.POSITIVE_INFINITY).toBeLessThan(
			oldHDeletionSpan?.start ?? Number.NEGATIVE_INFINITY,
		);
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
		expectEffectToContainMarkedText(
			effect,
			"~~(a) First.\n(b) Second.~~++(b) Second.\n(a) First.++",
		);
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
		expectEffectToContainMarkedText(effect, "~~alpha beta ~~gamma");
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
		expectEffectToContainMarkedText(effect, "(a) ~~old~~++new++");
	});

	it("applies punctuation strike-insert targets at end of scope", () => {
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
								strike: { punctuation: PunctuationKind.Period },
								insert: tp(", and"),
							},
						},
					],
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "(a) Alpha.",
		});

		expect(effect.status).toBe("ok");
		expectEffectToContainMarkedText(effect, "(a) Alpha~~.~~++, and++");
	});

	it("keeps inline punctuation insertions paragraph-covered when followed by add-at-end block insertion", () => {
		const originalText =
			"(II) which is directly adjoining to any census tract described in subclause (I).";
		const model = buildCanonicalDocument(originalText);
		const periodIndex = originalText.lastIndexOf(".");
		expect(periodIndex).toBeGreaterThan(-1);

		const applied = applyPlannedPatchesTransaction(model, [
			{
				operationIndex: 0,
				start: periodIndex + 1,
				end: periodIndex + 1,
				insertAt: periodIndex + 1,
				deletedPlain: "",
				insertedPlain: "\n(iv)\nAdded clause.",
				insertedSpans: [
					{ type: "paragraph", start: 1, end: 5 },
					{ type: "paragraph", start: 6, end: 18 },
				],
			},
			{
				operationIndex: 1,
				start: periodIndex,
				end: periodIndex + 1,
				insertAt: periodIndex + 1,
				deletedPlain: ".",
				insertedPlain: ", or",
				insertedSpans: [],
			},
		]);

		const inlineInsertStart = applied.plainText.indexOf(", or");
		expect(inlineInsertStart).toBeGreaterThan(-1);
		const inlineInsertEnd = inlineInsertStart + ", or".length;
		const inlineInsertSpan = applied.spans.find(
			(span) =>
				span.type === "insertion" &&
				span.start <= inlineInsertStart &&
				span.end >= inlineInsertEnd,
		);
		expect(inlineInsertSpan).toBeDefined();

		const containingParagraph = applied.spans.find(
			(span) =>
				span.type === "paragraph" &&
				span.start <= inlineInsertStart &&
				span.end >= inlineInsertEnd,
		);
		expect(containingParagraph).toBeDefined();
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
		expectEffectToContainMarkedText(
			effect,
			"~~(a) Old first.\n(b) Old second.\n~~++(a) New first.\n(b) New second.\n++(c) Keep.",
		);
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
		expect(beforeEffect.renderModel.plainText).toBe("new\n(a) old");
		expect(afterEffect.status).toBe("ok");
		expect(afterEffect.renderModel.plainText).toBe("(a) old\nnew");
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
		expect(beforeEffect.renderModel.plainText).toBe("new old text");
		expect(afterEffect.status).toBe("ok");
		expect(afterEffect.renderModel.plainText).toBe("old new text");
	});

	it("applies Insert before and after text anchors across inside-word hyphen differences", () => {
		const beforeTree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.Insert,
						content: tp("new"),
						before: { kind: SearchTargetKind.Text, text: tp("taxpayer") },
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
						after: { kind: SearchTargetKind.Text, text: tp("tax-payer") },
					},
				},
			],
		};

		const beforeEffect = applyAmendmentEditTreeToSection({
			tree: beforeTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "tax-payer relief",
		});
		const afterEffect = applyAmendmentEditTreeToSection({
			tree: afterTree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "taxpayer relief",
		});

		expect(beforeEffect.status).toBe("ok");
		expect(beforeEffect.renderModel.plainText).toBe("new tax-payer relief");
		expect(afterEffect.status).toBe("ok");
		expect(afterEffect.renderModel.plainText).toBe("taxpayer new relief");
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
		expect(byRefEffect.renderModel.plainText).toContain("(1) New item.");
		expect(byRestrictionEffect.status).toBe("ok");
		expect(byRestrictionEffect.renderModel.plainText).toContain(
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
		expect(effect.renderModel.plainText).toContain(
			"(c) Newly added subsection.",
		);
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
			"> (A) IN GENERAL.—Except as provided in subparagraph (B), in the case of any increase.",
			"(3) Carry-over of reductions.",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/1359cc",
			sectionBody,
			instructionText: "by adding at the end the following:",
		});

		expect(effect.status).toBe("ok");
		const result = effect.renderModel.plainText ?? "";
		const indexOfA = result.indexOf("(A) IN GENERAL");
		const indexOfB = result.indexOf("(B) Exception");
		const addAtEndAttempt = effect.debug.operationAttempts.find(
			(item) => item.operationType === "insert",
		);
		expect(indexOfA).toBeGreaterThanOrEqual(0);
		expect(indexOfB).toBeGreaterThanOrEqual(0);
		expect(addAtEndAttempt?.scopedRange?.preview).toContain("(A) IN GENERAL");
		expect(indexOfB).toBeGreaterThan(indexOfA);
	});

	it("splits inserted marker block into individual paragraph spans", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "1",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "c" },
					children: [
						{
							type: SemanticNodeType.Edit,
							edit: {
								kind: UltimateEditKind.Insert,
								content: tp(
									"(5) ASSISTANCE FOR LOSSES DUE TO BIRD DEPREDATION.—\n(A) DEFINITION OF FARM-RAISED FISH.—\n(B) PAYMENTS.—\n(C) PAYMENT RATE.—",
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
			sectionBody: "(c) Existing text.",
			instructionText: "by adding at the end the following:",
		});

		expect(effect.status).toBe("ok");
		const insertionSpan = effect.renderModel.spans.find(
			(span) => span.type === "insertion",
		);
		expect(insertionSpan).toBeDefined();
		const insertedParagraphs = effect.renderModel.spans
			.filter(
				(span) =>
					span.type === "paragraph" &&
					insertionSpan &&
					span.start < insertionSpan.end &&
					span.end > insertionSpan.start,
			)
			.map((span) => effect.renderModel.plainText.slice(span.start, span.end));

		expect(insertedParagraphs.some((text) => text.startsWith("(5)"))).toBe(
			true,
		);
		expect(insertedParagraphs.some((text) => text.startsWith("(A)"))).toBe(
			true,
		);
		expect(insertedParagraphs.some((text) => text.startsWith("(B)"))).toBe(
			true,
		);
		expect(insertedParagraphs.some((text) => text.startsWith("(C)"))).toBe(
			true,
		);
	});

	it("preserves inserted paragraph spans for multiline strike-insert replacements", () => {
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
							text: tp("county for at least 8 consecutive"),
						},
						insert: tp(
							"county for not less than—\n(aa) 4 consecutive weeks;\n(bb) 7 of the previous 8 consecutive",
						),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/9081",
			sectionBody:
				"An eligible livestock producer in a county for at least 8 consecutive weeks during the normal grazing period.",
			instructionText:
				'by striking "county for at least 8 consecutive" and inserting the following.',
		});

		expect(effect.status).toBe("ok");
		const insertionSpan = effect.renderModel.spans.find(
			(span) => span.type === "insertion",
		);
		expect(insertionSpan).toBeDefined();

		const insertedParagraphs = effect.renderModel.spans
			.filter(
				(span) =>
					span.type === "paragraph" &&
					insertionSpan !== undefined &&
					span.start >= insertionSpan.start &&
					span.end <= insertionSpan.end,
			)
			.map((span) => ({
				text: effect.renderModel.plainText.slice(span.start, span.end),
				quoteDepth: Number(span.metadata?.quoteDepth ?? 0),
			}));

		const containingParagraph = effect.renderModel.spans.find(
			(span) =>
				span.type === "paragraph" &&
				span.start < (insertionSpan?.start ?? 0) &&
				span.end > (insertionSpan?.start ?? 0),
		);
		expect(containingParagraph).toBeDefined();
		expect(
			effect.renderModel.plainText.slice(
				containingParagraph?.start ?? 0,
				containingParagraph?.end ?? 0,
			),
		).toContain("county for not less than—");

		expect(
			insertedParagraphs.some(
				(paragraph) =>
					paragraph.text.startsWith("(aa) 4 consecutive weeks;") &&
					paragraph.quoteDepth > 0,
			),
		).toBe(true);
		expect(
			insertedParagraphs.some(
				(paragraph) =>
					paragraph.text.startsWith("(bb) 7 of the previous 8 consecutive") &&
					paragraph.quoteDepth > 0,
			),
		).toBe(true);
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
		expect(effect.changes[0]?.deleted).not.toContain("(c) RATE.");
		expect(effect.changes[0]?.deleted).not.toContain(
			"(1) The value of the assistance",
		);
		expect(effect.changes[0]?.deleted).toContain(
			"(2) The value of the assistance",
		);
		const result = effect.renderModel.plainText ?? "";
		expect(result).toContain("(c) RATE.");
		expect(result).toContain("(1) The value of the assistance");
		expect(result).toContain("(2) Value of assistance");
		expect(result).toContain("5 cents per pound.\n(3) No overlap.");
	});

	it("requires quoted depth to resolve nested scope in hierarchy layouts", () => {
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
		expect(effect.applySummary.failedItems).toHaveLength(0);
	});
});

describe("applyAmendmentEditTreeToSection unit tree-shape coverage", () => {
	const applyVariant = (tree: InstructionSemanticTree, sectionBody: string) =>
		applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody,
		});
	const hasStrongSpanText = (
		effect: ReturnType<typeof applyVariant>,
		text: string,
	): boolean =>
		effect.renderModel.spans.some(
			(span) =>
				span.type === "strong" &&
				effect.renderModel.plainText.slice(span.start, span.end) === text,
		);

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
		expectEffectToContainMarkedText(
			effect,
			"First sentence old. Last sentence ~~old~~++new++.",
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
		expectEffectToContainMarkedText(effect, "Intro ~~old text~~++new text++.");
		expect(effect.renderModel.plainText).toContain(
			"(2) old text in paragraph two.",
		);
		expect(hasStrongSpanText(effect, "(2)")).toBe(true);
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
		expect(effect.renderModel.plainText).toContain(
			"(1) old text in paragraph one.",
		);
		expectEffectToContainMarkedText(
			effect,
			"(2) ~~old text~~++new text++ in paragraph two.",
		);
		expect(hasStrongSpanText(effect, "(1)")).toBe(true);
		expect(hasStrongSpanText(effect, "(2)")).toBe(true);
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
		expectEffectToContainMarkedText(
			effect,
			"(b) Intro ~~old text~~++new text++ for subsection b.",
		);
		expect(effect.renderModel.plainText).toContain(
			"(A) old text in subparagraph A.",
		);
		expect(hasStrongSpanText(effect, "(b)")).toBe(true);
		expect(hasStrongSpanText(effect, "(A)")).toBe(true);
	});

	it("resolves matter-preceding clause targets inside quoted USC-style subparagraphs", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "9016",
			children: [
				{
					type: SemanticNodeType.Scope,
					scope: { kind: ScopeKind.Subsection, label: "c" },
					children: [
						{
							type: SemanticNodeType.Scope,
							scope: { kind: ScopeKind.Paragraph, label: "1" },
							children: [
								{
									type: SemanticNodeType.Scope,
									scope: { kind: ScopeKind.Subparagraph, label: "B" },
									children: [
										{
											type: SemanticNodeType.LocationRestriction,
											restriction: {
												kind: LocationRestrictionKind.MatterPreceding,
												ref: {
													kind: ScopeKind.Clause,
													path: [{ kind: ScopeKind.Clause, label: "i" }],
												},
											},
											children: [
												{
													type: SemanticNodeType.Edit,
													edit: {
														kind: UltimateEditKind.StrikeInsert,
														strike: {
															kind: SearchTargetKind.Text,
															text: tp("2023"),
														},
														insert: tp("2031"),
													},
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		};

		const sectionBody = [
			"**(c)** Eligibility for payments",
			"",
			"> **(1)** General rule",
			"",
			"> > **(B)** 2019 through 2023 crop years",
			"",
			"> > For the 2019 through 2023 crop years, the payment rate shall be equal to the difference between—",
			"",
			"> > > **(i)** the effective reference price for the covered commodity; and",
			"",
			"> > > **(ii)** the effective price determined under subsection (b) for the covered commodity.",
		].join("\n");

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/9016",
			sectionBody,
			instructionText:
				'in subsection (c)(1)(B), in the matter preceding clause (i), by striking "2023" and inserting "2031".',
		});

		expect(effect.status).toBe("ok");
		expect(effect.applySummary.failedItems).toEqual([]);
		expectEffectToContainMarkedText(
			effect,
			"(B) 2019 through ~~2023~~++2031++ crop years",
		);
		expect(effect.renderModel.plainText).toContain(
			"(i) the effective reference price for the covered commodity; and",
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
	it("shifts post-insertion spans when inserted text has paragraph spans", () => {
		const model: CanonicalDocument = {
			plainText: "AAA\n(c) Enforcement\nZZZ",
			spans: [
				{ type: "paragraph", start: 0, end: 3 },
				{ type: "paragraph", start: 4, end: 19 },
				{ type: "heading", start: 4, end: 19 },
			],
			rootRange: { start: 0, end: 22, indent: null },
			nodesById: new Map(),
			rootNodeIds: [],
			paragraphs: [],
		};

		const patch: PlannedPatch = {
			operationIndex: 0,
			start: 4,
			end: 4,
			insertAt: 4,
			deletedPlain: "",
			insertedPlain: "(4)\nbody",
			insertedSpans: [
				{ type: "paragraph", start: 0, end: 3 },
				{ type: "paragraph", start: 4, end: 8 },
			],
		};

		const applied = applyPlannedPatchesTransaction(model, [patch]);
		const headingSpan = applied.spans.find((span) => span.type === "heading");

		expect(headingSpan).toBeDefined();
		expect(headingSpan?.start).toBe(12);
		expect(headingSpan?.end).toBe(27);
		expect(
			applied.plainText.slice(headingSpan?.start ?? 0, headingSpan?.end ?? 0),
		).toBe("(c) Enforcement");
	});

	it("applies HR1 sec. 10103 and 10104 semantic trees against the USC 7/2014 markdown fixture", () => {
		const parser = createHandcraftedInstructionParser();
		const sectionBody = readFileSync(USC_2014_PRE_FIXTURE_PATH, "utf8").trim();
		const allOperations: ResolvedInstructionOperation[] = [];
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

			const model = buildCanonicalDocument(sectionBody);
			const counter = { index: allOperations.length };
			const walked = walkTree(
				model,
				translated.tree.children,
				{
					target: (translated.tree.targetScopePath ?? [])
						.filter(
							(
								s,
							): s is Exclude<TargetScopeSegment, { kind: "note_reference" }> =>
								s.kind !== "note_reference",
						)
						.map((s) => ({
							type: s.kind,
							val: s.label,
						})),
					scopeContextTexts: [],
					matterPreceding: null,
					matterPrecedingTarget: null,
					matterFollowingTarget: null,
					unanchoredInsertMode: /\badding at the end\b/i.test(
						instruction.text ?? "",
					)
						? "add_at_end"
						: "insert",
					sentenceOrdinal: null,
					atEndOnly: false,
					classificationOverrides: [],
					redesignations: new Map(),
				},
				counter,
			);
			allOperations.push(...walked.resolved);
		}

		const model = buildCanonicalDocument(sectionBody);
		const { patches } = planEdits(model, allOperations, []);
		const applied = applyPlannedPatchesTransaction(model, patches);
		const finalBody = applied.plainText;

		expect(finalBody).toContain(
			"households with an elderly or disabled member that received a payment",
		);
		expect(finalBody).toContain(
			"to a household without an elderly or disabled member shall be considered money payable directly to the household.",
		);
		expect(finalBody).toContain(
			"expense paid on behalf of a household with an elderly or disabled member under a State law",
		);
		expect(finalBody).toContain(
			"(E) Restrictions on internet expenses\nAny service fee associated with internet connection",
		);
	});

	it("translates instruction text using classification overrides", () => {
		const tree: InstructionSemanticTree = {
			type: SemanticNodeType.InstructionRoot,
			targetSection: "2012",
			children: [
				{
					type: SemanticNodeType.Edit,
					edit: {
						kind: UltimateEditKind.StrikeInsert,
						strike: {
							kind: SearchTargetKind.Text,
							text: tp("section 3(u)(4)"),
						},
						insert: tp("section 3(u)(3)"),
					},
				},
			],
		};

		const effect = applyAmendmentEditTreeToSection({
			tree,
			sectionPath: "/statutes/usc/section/7/2036",
			sectionBody: "As defined in section 2012(u)(4) of this title.",
			instructionText:
				'Section 16 is amended by striking "section 3(u)(4)" and inserting "section 3(u)(3)".',
			classificationOverrides: [
				{
					congress: 118,
					publicLawNumber: "118-1",
					pubLawSec: "3",
					uscTitle: "7",
					uscSection: "2012",
					description: null,
				},
			],
		});

		expect(effect.status).toBe("ok");
		expect(effect.applySummary.wasTranslated).toBe(true);
		expectEffectToContainMarkedText(
			effect,
			"As defined in ~~section 2012(u)(4)~~++section 2012(u)(3)++ of this title.",
		);
		// The instruction text should be translated in the summary
		expect(effect.debug.operationAttempts[0]?.wasTranslated).toBe(true);
		expect(
			effect.debug.operationAttempts[0]?.translatedInstructionText,
		).toContain("section 2012(u)(4)");
	});
});
