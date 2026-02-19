import { describe, expect, it } from "vitest";
import type { AmendatoryInstruction } from "../amendatory-instructions";
import {
	type InstructionSemanticTree,
	SearchTargetKind,
	SemanticNodeType,
	UltimateEditKind,
} from "../amendment-edit-tree";
import { applyAmendmentEditTreeToSection } from "../amendment-edit-tree-apply";

describe("applyAmendmentEditTreeToSection", () => {
	it("applies strike-and-insert text edits", () => {
		const instruction: AmendatoryInstruction = {
			billSection: "SEC. 1.",
			target: "Section 1",
			uscCitation: "1 U.S.C. 1",
			text: 'Section 1 is amended by striking "old" and inserting "new".',
			paragraphs: [],
			startPage: 1,
			endPage: 1,
			rootQuery: [{ type: "section", val: "1" }],
			tree: [],
		};

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
			instruction,
			sectionPath: "/statutes/usc/section/1/1",
			sectionBody: "This is old text.",
		});

		expect(effect.status).toBe("ok");
		expect(effect.segments[0]?.text).toBe("This is new text.");
		expect(effect.deleted).toEqual(["old"]);
		expect(effect.inserted).toEqual(["new"]);
	});
});
