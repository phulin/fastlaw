import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import {
	InnerLocationTargetKind,
	LocationRestrictionKind,
	PunctuationKind,
	SemanticNodeType,
	TextLocationAnchorKind,
	UltimateEditKind,
} from "../amendment-edit-tree";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";
import { parseFixtureParagraphs } from "./test-utils";

function parseInstructionAst(input: string) {
	const parser = createHandcraftedInstructionParser();
	const parsed = parser.parseInstructionFromLines(input.split("\n"), 0);
	if (!parsed) throw new Error("Expected instruction to parse.");
	return parsed.ast;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");
const HR1_FIXTURE_PATH = resolve(
	WEB_ROOT,
	"src/lib/__fixtures__/hr1-abridged-output.txt",
);
const hasHr1Fixture = existsSync(HR1_FIXTURE_PATH);

describe("translateInstructionAstToEditTree", () => {
	it("translates sentence ordinal text location with explicit anchor", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in the first sentence of subsection (a) by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(
			LocationRestrictionKind.SentenceOrdinal,
		);
		if (
			locationNode.restriction.kind === LocationRestrictionKind.SentenceOrdinal
		) {
			expect(locationNode.restriction.ordinal).toBe(1);
			expect(locationNode.restriction.anchor?.kind).toBe(
				TextLocationAnchorKind.Of,
			);
		}
	});

	it("translates sub-location heading text location", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in the paragraph heading thereof by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(
			LocationRestrictionKind.SubLocationHeading,
		);
		if (
			locationNode.restriction.kind ===
			LocationRestrictionKind.SubLocationHeading
		) {
			expect(locationNode.restriction.anchor?.kind).toBe(
				TextLocationAnchorKind.Thereof,
			);
		}
	});

	it("translates matter-preceding text location", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in the matter preceding paragraph (2) by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(
			LocationRestrictionKind.MatterPreceding,
		);
	});

	it("translates sentence-last text location", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in the last sentence by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(
			LocationRestrictionKind.SentenceLast,
		);
	});

	it("translates heading text location with structural anchor", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in the heading of subsection (a) by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.Heading);
		if (locationNode.restriction.kind === LocationRestrictionKind.Heading) {
			expect(locationNode.restriction.anchor?.kind).toBe(
				TextLocationAnchorKind.Of,
			);
		}
	});

	it("translates matter-following text location", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in the matter following paragraph (2) by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(
			LocationRestrictionKind.MatterFollowing,
		);
	});

	it("translates before inner-location for punctuation period at end of a structural reference", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended before the period at the end of subsection (a) by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.Before);
		if (locationNode.restriction.kind === LocationRestrictionKind.Before) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.Punctuation,
			);
			if (
				locationNode.restriction.target.kind ===
				InnerLocationTargetKind.Punctuation
			) {
				expect(locationNode.restriction.target.punctuation).toBe(
					PunctuationKind.Period,
				);
				expect(locationNode.restriction.target.atEndOf?.path[0]?.label).toBe(
					"a",
				);
			}
		}
	});

	it("translates after inner-location for punctuation semicolon", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) after the semicolon, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.After);
		if (locationNode.restriction.kind === LocationRestrictionKind.After) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.Punctuation,
			);
			if (
				locationNode.restriction.target.kind ===
				InnerLocationTargetKind.Punctuation
			) {
				expect(locationNode.restriction.target.punctuation).toBe(
					PunctuationKind.Semicolon,
				);
			}
		}
	});

	it("translates after inner-location for punctuation comma", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) after the comma, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.After);
		if (locationNode.restriction.kind === LocationRestrictionKind.After) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.Punctuation,
			);
			if (
				locationNode.restriction.target.kind ===
				InnerLocationTargetKind.Punctuation
			) {
				expect(locationNode.restriction.target.punctuation).toBe(
					PunctuationKind.Comma,
				);
			}
		}
	});

	it("translates before inner-location for heading", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) before the heading, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.Before);
		if (locationNode.restriction.kind === LocationRestrictionKind.Before) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.Heading,
			);
		}
	});

	it("translates before inner-location for subsection heading", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) before the subsection heading, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.Before);
		if (locationNode.restriction.kind === LocationRestrictionKind.Before) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.SubsectionHeading,
			);
		}
	});

	it("translates before inner-location for section designation", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) before the section designation, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.Before);
		if (locationNode.restriction.kind === LocationRestrictionKind.Before) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.SectionDesignation,
			);
		}
	});

	it("translates after inner-location for ordinal sentence", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) after the second sentence, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.After);
		if (locationNode.restriction.kind === LocationRestrictionKind.After) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.SentenceOrdinal,
			);
			if (
				locationNode.restriction.target.kind ===
				InnerLocationTargetKind.SentenceOrdinal
			) {
				expect(locationNode.restriction.target.ordinal).toBe(2);
			}
		}
	});

	it("translates after inner-location for last sentence", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended—\n(A) after the last sentence, by striking “A”.",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}

		expect(locationNode.restriction.kind).toBe(LocationRestrictionKind.After);
		if (locationNode.restriction.kind === LocationRestrictionKind.After) {
			expect(locationNode.restriction.target.kind).toBe(
				InnerLocationTargetKind.SentenceLast,
			);
		}
	});

	it("translates plural in-location and uses it for moving such sections", () => {
		const ast = parseInstructionAst(
			"Section 101 of title 10, United States Code, is amended in subsections (a) and (b) by moving such sections before subsection (c).",
		);
		const result = translateInstructionAstToEditTree(ast);
		const locationNode = result.tree.children[0];
		if (
			!locationNode ||
			locationNode.type !== SemanticNodeType.LocationRestriction
		) {
			throw new Error("Expected top-level location restriction.");
		}
		if (locationNode.restriction.kind !== LocationRestrictionKind.In) {
			throw new Error("Expected in-location restriction.");
		}
		expect(locationNode.restriction.refs).toHaveLength(2);

		const editNode = locationNode.children[0];
		if (!editNode || editNode.type !== SemanticNodeType.Edit) {
			throw new Error("Expected edit child.");
		}
		expect(editNode.edit.kind).toBe(UltimateEditKind.Move);
		if (editNode.edit.kind === UltimateEditKind.Move) {
			expect(editNode.edit.from).toHaveLength(2);
			expect(editNode.edit.before?.path[0]?.label).toBe("c");
		}
	});
});

describe.skipIf(!hasHr1Fixture)(
	"translateInstructionAstToEditTree HR1 paragraph integration",
	() => {
		const parser = createHandcraftedInstructionParser();
		const fixtureText = readFileSync(HR1_FIXTURE_PATH, "utf8");
		const fixtureParagraphs = parseFixtureParagraphs(fixtureText);
		const instructions = extractAmendatoryInstructions(fixtureParagraphs);

		const findByCitation = (citation: string) => {
			const instruction = instructions.find(
				(item) => item.uscCitation === citation,
			);
			if (!instruction) throw new Error(`Missing HR1 instruction: ${citation}`);
			return instruction;
		};

		const hr1Citations = [
			"7 U.S.C. 2012",
			"7 U.S.C. 2025(c)(1)(A)(ii)(II)",
			"7 U.S.C. 2028(a)(2)(A)(ii)",
			"7 U.S.C. 2036(a)(2)",
			"7 U.S.C. 2015(o)",
			"7 U.S.C. 2015(o)(4)",
			"7 U.S.C. 2014(e)(6)(C)(iv)(I)",
			"7 U.S.C. 2014(k)(4)",
			"7 U.S.C. 2014(e)(6)",
			"7 U.S.C. 2013(a)",
		];

		it("parses and translates 10 HR1 instructions from extracted paragraphs", () => {
			for (const citation of hr1Citations) {
				const instruction = findByCitation(citation);
				const parsed = parser.parseInstructionFromLines(
					instruction.text.split("\n"),
					0,
				);
				expect(parsed, citation).not.toBeNull();
				if (!parsed) continue;
				const translated = translateInstructionAstToEditTree(parsed.ast);
				expect(
					translated.issues,
					`${citation}: ${translated.issues.map((i) => i.message).join("; ")}`,
				).toHaveLength(0);
				expect(translated.tree.children.length, citation).toBeGreaterThan(0);
			}
		});

		it("keeps concrete move/rewrite/insert semantics in HR1 samples", () => {
			const section2015o4 = findByCitation("7 U.S.C. 2015(o)(4)");
			const parsed2015o4 = parser.parseInstructionFromLines(
				section2015o4.text.split("\n"),
				0,
			);
			expect(parsed2015o4).not.toBeNull();
			if (!parsed2015o4) return;
			const tree2015o4 = translateInstructionAstToEditTree(
				parsed2015o4.ast,
			).tree;
			expect(
				JSON.stringify(tree2015o4).includes(UltimateEditKind.StrikeInsert),
			).toBe(true);

			const section2014e6 = findByCitation("7 U.S.C. 2014(e)(6)");
			const parsed2014e6 = parser.parseInstructionFromLines(
				section2014e6.text.split("\n"),
				0,
			);
			expect(parsed2014e6).not.toBeNull();
			if (!parsed2014e6) return;
			const tree2014e6 = translateInstructionAstToEditTree(
				parsed2014e6.ast,
			).tree;
			expect(JSON.stringify(tree2014e6).includes(UltimateEditKind.Insert)).toBe(
				true,
			);
		});
	},
);
