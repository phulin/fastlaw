import { describe, expect, it } from "vitest";
import {
	type InstructionSemanticTree,
	LocationRestrictionKind,
	ScopeKind,
	SearchTargetKind,
	SemanticNodeType,
	UltimateEditKind,
} from "../amendment-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";
import { expectEffectToContainMarkedText, tp } from "./test-utils";

function apply(
	tree: InstructionSemanticTree,
	sectionBody: string,
	instructionText = "",
) {
	return applyAmendmentEditTreeToSection({
		tree,
		sectionPath: "/statutes/usc/section/1/1",
		sectionBody,
		instructionText,
	});
}

describe("sequential amendment edit engine", () => {
	describe("scope resolution", () => {
		it("resolves nested scope paths and edits only matching scope", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "1",
				children: [
					{
						type: SemanticNodeType.Scope,
						scope: { kind: ScopeKind.Subsection, label: "b" },
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

			const effect = apply(
				tree,
				"(a) old in a.\n(b) old in b.",
				"In subsection (b), strike old and insert new.",
			);

			expect(effect.status).toBe("ok");
			expect(effect.renderModel.plainText).toContain("(a) old in a.");
			expectEffectToContainMarkedText(effect, "(b) ~~old~~++new++ in b.");
		});

		it("resolves In-location refs and applies edits to each referenced scope", () => {
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
									path: [{ kind: ScopeKind.Subsection, label: "c" }],
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

			const effect = apply(tree, "(a) old one.\n(b) old two.\n(c) old three.");

			expect(effect.status).toBe("ok");
			expect(effect.renderModel.plainText).toContain("(b) old two.");
			expect(effect.changes).toHaveLength(2);
			expect(effect.changes.every((change) => change.deleted === "old")).toBe(
				true,
			);
		});

		it("applies sentence-ordinal restrictions inside resolved scope", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "1",
				children: [
					{
						type: SemanticNodeType.LocationRestriction,
						restriction: {
							kind: LocationRestrictionKind.SentenceOrdinal,
							ordinal: 2,
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

			const effect = apply(tree, "First old sentence. Second old sentence.");

			expect(effect.status).toBe("ok");
			expect(effect.renderModel.plainText).toContain("First old sentence.");
			expectEffectToContainMarkedText(
				effect,
				"Second ~~old~~++new++ sentence.",
			);
		});
	});

	describe("each edit type", () => {
		it("supports Strike", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "1",
				children: [
					{
						type: SemanticNodeType.Edit,
						edit: {
							kind: UltimateEditKind.Strike,
							target: { kind: SearchTargetKind.Text, text: tp("obsolete") },
						},
					},
				],
			};
			const effect = apply(tree, "obsolete language");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(effect, "~~obsolete~~ language");
		});

		it("supports Insert before anchor text", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "1",
				children: [
					{
						type: SemanticNodeType.Edit,
						edit: {
							kind: UltimateEditKind.Insert,
							content: tp("new "),
							before: { kind: SearchTargetKind.Text, text: tp("term") },
						},
					},
				],
			};
			const effect = apply(tree, "term appears");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(effect, "++new ++term appears");
		});

		it("supports Insert before anchor text with case-insensitive match", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "1",
				children: [
					{
						type: SemanticNodeType.Edit,
						edit: {
							kind: UltimateEditKind.Insert,
							content: tp("new "),
							before: { kind: SearchTargetKind.Text, text: tp("term") },
						},
					},
				],
			};
			const effect = apply(tree, "TERM appears");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(effect, "++new ++TERM appears");
		});

		it("supports StrikeInsert", () => {
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
			const effect = apply(tree, "old value");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(effect, "~~old~~++new++ value");
		});

		it("supports StrikeInsert with case-insensitive strike match", () => {
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
								text: tp("2018 THROUGH 2025"),
							},
							insert: tp("BEGINNING AFTER 2017"),
						},
					},
				],
			};
			const effect = apply(
				tree,
				"(j) Modifications for taxable years 2018 through 2025",
			);
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(
				effect,
				"(j) Modifications for taxable years ~~2018 through 2025~~++BEGINNING AFTER 2017++",
			);
		});

		it("supports Rewrite", () => {
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
			const effect = apply(tree, "Original text.");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(
				effect,
				"~~Original text.~~++Replacement text.++",
			);
		});

		it("supports Redesignate", () => {
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
			const effect = apply(tree, "(a) text.");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(effect, "~~(a)~~++(b)++ text.");
		});

		it("supports Move", () => {
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
			const effect = apply(tree, "(a) First.\n(b) Second.");
			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(
				effect,
				"~~(a) First.\n(b) Second.~~++(b) Second.\n(a) First.++",
			);
		});
	});

	describe("sequential application", () => {
		it("applies redesignate -> scoped edit using redesignated label", () => {
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
					{
						type: SemanticNodeType.Scope,
						scope: { kind: ScopeKind.Paragraph, label: "b" },
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

			const effect = apply(tree, "(a) old text.");

			expect(effect.status).toBe("ok");
			expect(effect.changes).toHaveLength(2);
			expect(effect.changes[0]?.deleted).toBe("(a)");
			expect(effect.changes[1]?.deleted).toBe("old");
			expect(effect.applySummary.failedItems).toHaveLength(0);
		});

		it("applies edit -> edit when second edit targets first edit output", () => {
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
							strike: { kind: SearchTargetKind.Text, text: tp("new") },
							insert: tp("final"),
						},
					},
				],
			};

			const effect = apply(tree, "old value");

			expect(effect.status).toBe("ok");
			expect(effect.changes).toHaveLength(2);
			expect(effect.changes[0]?.deleted).toBe("old");
			expect(effect.changes[1]?.deleted).toBe("new");
			expect(effect.applySummary.failedItems).toHaveLength(0);
		});

		it("applies insert -> edit where second edit targets inserted text", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "1",
				children: [
					{
						type: SemanticNodeType.Edit,
						edit: {
							kind: UltimateEditKind.Insert,
							content: tp(" and beta"),
							after: { kind: SearchTargetKind.Text, text: tp("alpha") },
						},
					},
					{
						type: SemanticNodeType.Edit,
						edit: {
							kind: UltimateEditKind.StrikeInsert,
							strike: { kind: SearchTargetKind.Text, text: tp("beta") },
							insert: tp("gamma"),
						},
					},
				],
			};

			const effect = apply(tree, "alpha");

			expect(effect.status).toBe("ok");
			expectEffectToContainMarkedText(effect, "alpha and ~~beta~~++gamma++");
			expect(effect.changes).toHaveLength(2);
			expect(effect.changes[0]?.inserted).toContain("beta");
			expect(effect.changes[1]?.deleted).toBe("beta");
		});

		it("applies move -> edit where second edit targets moved scope", () => {
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
					{
						type: SemanticNodeType.Scope,
						scope: { kind: ScopeKind.Paragraph, label: "a" },
						children: [
							{
								type: SemanticNodeType.Edit,
								edit: {
									kind: UltimateEditKind.StrikeInsert,
									strike: { kind: SearchTargetKind.Text, text: tp("First") },
									insert: tp("Moved"),
								},
							},
						],
					},
				],
			};

			const effect = apply(tree, "(a) First.\n(b) Second.");

			expect(effect.status).toBe("ok");
			expect(effect.changes).toHaveLength(2);
			expect(effect.changes[1]?.deleted).toBe("First");
			expect(effect.changes[1]?.inserted).toBe("Moved");
			expect(effect.applySummary.failedItems).toHaveLength(0);
		});

		it("preserves quoted hierarchy for later matter-preceding resolution", () => {
			const tree: InstructionSemanticTree = {
				type: SemanticNodeType.InstructionRoot,
				targetSection: "9016",
				children: [
					{
						type: SemanticNodeType.Scope,
						scope: { kind: ScopeKind.Subsection, label: "a" },
						children: [
							{
								type: SemanticNodeType.Edit,
								edit: {
									kind: UltimateEditKind.StrikeInsert,
									strike: { kind: SearchTargetKind.Text, text: tp("2023") },
									insert: tp("2031"),
								},
							},
						],
					},
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

			const sectionBody = `**(a)** **General**
For 2023, this subsection applies.

**(c)** **Payment rate**

> **(1)** **In general**
>
> > **(B)** **2019 through 2023 crop years**
> >
> > For the 2019 through 2023 crop years, the payment rate shall be equal to the difference between—
> >
> > > **(i)** the effective reference price for the covered commodity; and
> >
> > > **(ii)** the effective price determined under subsection (b) for the covered commodity.`;

			const effect = apply(tree, sectionBody);

			expect(effect.status).toBe("ok");
			expect(effect.applySummary.failedItems).toHaveLength(0);
			expect(effect.changes).toHaveLength(2);
			expect(effect.changes[0]?.deleted).toBe("2023");
			expect(effect.changes[1]?.deleted).toBe("2023");
			expectEffectToContainMarkedText(
				effect,
				"For the 2019 through ~~2023~~++2031++ crop years",
			);
		});
	});
});
