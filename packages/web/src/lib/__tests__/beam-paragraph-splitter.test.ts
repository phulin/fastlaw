import { describe, expect, it } from "vitest";
import {
	type HierarchyMarker,
	HierarchyStack,
	LevelType,
	splitParagraphsBeamSearch,
} from "../beam-paragraph-splitter";
import type { Line } from "../text-extract";

function line(text: string, xStart: number, page = 1): Line {
	return {
		page,
		y: 700,
		yStart: 714,
		yEnd: 700,
		xStart,
		xEnd: xStart + text.length * 5,
		text,
		items: [],
		pageHeight: 792,
		isBold: false,
	};
}

function marker(
	token: string,
	level: LevelType,
	chain?: HierarchyMarker["chain"],
): HierarchyMarker {
	return {
		token,
		level,
		chain: chain ?? [{ token, level }],
	};
}

describe("splitParagraphsBeamSearch", () => {
	it("forces a split at SEC. markers", () => {
		const lines: Line[] = [
			line("Introductory text.", 100),
			line("SEC. 101. TEST SECTION.", 100),
			line("Body for the section.", 100),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(3);
		expect(paragraphs[1]?.text).toBe("SEC. 101. TEST SECTION.");
	});

	it("starts a new paragraph on list marker lines", () => {
		const lines: Line[] = [
			line("Section 5 is amended—", 100),
			line("(1) by striking subsection (a);", 120),
			line("(2) by redesignating paragraph (b).", 120),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(3);
		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
			"Section 5 is amended—",
			"(1) by striking subsection (a);",
			"(2) by redesignating paragraph (b).",
		]);
	});

	it("keeps punctuation continuations together", () => {
		const lines: Line[] = [
			line("by striking 'old',", 100),
			line("and inserting 'new'.", 100),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe("by striking 'old', and inserting 'new'.");
	});

	it("splits sibling marker lines that end with semicolons", () => {
		const lines: Line[] = [
			line(
				"(6) $400,000,000 to accelerate the development of Trident D5LE2 submarine-launched ballistic missiles;",
				120,
			),
			line(
				"(7) $2,000,000,000 to accelerate the development, procurement, and integration of the nuclear-armed sea-launched cruise missile;",
				120,
			),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(2);
		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
			"(6) $400,000,000 to accelerate the development of Trident D5LE2 submarine-launched ballistic missiles;",
			"(7) $2,000,000,000 to accelerate the development, procurement, and integration of the nuclear-armed sea-launched cruise missile;",
		]);
	});

	it("keeps long numbered appropriation items split", () => {
		const lines: Line[] = [
			line(
				"(a) DOD APPROPRIATIONS.—In addition to amounts otherwise available, there are appropriated to the Secretary of Defense for fiscal year 2025, out of any money in the Treasury not otherwise appropriated, to remain available until September 30, 2029—(1) $2,500,000,000 for risk reduction activities for the Sentinel intercontinental ballistic missile program;",
				100,
			),
			line(
				"(2) $4,500,000,000 only for expansion of production capacity of B-21 long-range bomber aircraft and the purchase of aircraft only available through the expansion of production capacity;",
				120,
			),
			line(
				"(3) $500,000,000 for improvements to the Minuteman III intercontinental ballistic missile system;",
				120,
			),
			line(
				"(4) $100,000,000 for capability enhancements to intercontinental ballistic missile reentry vehicles;",
				120,
			),
			line(
				"(5) $148,000,000 for the expansion of D5 missile motor production;",
				120,
			),
			line(
				"(6) $400,000,000 to accelerate the development of Trident D5LE2 submarine-launched ballistic missiles;",
				120,
			),
			line(
				"(7) $2,000,000,000 to accelerate the development, procurement, and integration of the nuclear-armed sea-launched cruise missile;",
				120,
			),
			line(
				"(8) $62,000,000 to convert Ohio-class submarine tubes to accept additional missiles, not to be obligated before March 1, 2026;",
				120,
			),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(8);
	});

	it("treats multi-marker starts as structural markers", () => {
		const lines: Line[] = [
			line(
				"“(ii) is not enrolled in an institution of higher education; and",
				120,
			),
			line(
				"“(iii)(I) in the case of a determination made for an educational program that awards a baccalaureate or lesser degree, has only a high school diploma or its recognized equivalent; or",
				120,
			),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(2);
		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
			"“(ii) is not enrolled in an institution of higher education; and",
			"“(iii)(I) in the case of a determination made for an educational program that awards a baccalaureate or lesser degree, has only a high school diploma or its recognized equivalent; or",
		]);
	});

	it("treats AA/BB subitems as markers", () => {
		const lines: Line[] = [
			line(
				"“(AA) the applicable percent of net patient revenue attributable to such class that has been so determined; and",
				120,
			),
			line(
				"“(BB) the applicable percent specified in clause (ii) for the fiscal year; and",
				120,
			),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(2);
		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
			"“(AA) the applicable percent of net patient revenue attributable to such class that has been so determined; and",
			"“(BB) the applicable percent specified in clause (ii) for the fiscal year; and",
		]);
	});

	it("keeps citation-like chained markers as continuation text", () => {
		const lines: Line[] = [
			line(
				"(1) by striking “in subsections (b)(2) and (c)(2)(A)” and inserting “in subsections (b)(2),",
				120,
			),
			line(
				"(c)(2)(A), and in the case of taxable years beginning after 2026, (c)(1)(E)(ii)(II)”,",
				120,
			),
		];

		const paragraphs = splitParagraphsBeamSearch(lines);

		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe(
			"(1) by striking “in subsections (b)(2) and (c)(2)(A)” and inserting “in subsections (b)(2), (c)(2)(A), and in the case of taxable years beginning after 2026, (c)(1)(E)(ii)(II)”,",
		);
	});
});

describe("HierarchyStack", () => {
	it("detects sibling, descend, and ascend continuation relations", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "a" },
		]);

		expect(stack.continuationRelation(marker("b", LevelType.Subsection))).toBe(
			"sibling",
		);
		expect(stack.continuationRelation(marker("1", LevelType.Paragraph))).toBe(
			"descend",
		);

		stack.applyMarker(marker("1", LevelType.Paragraph));

		expect(stack.continuationRelation(marker("b", LevelType.Subsection))).toBe(
			"ascend",
		);
	});

	it("applies marker updates by popping same-or-deeper levels", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "a" },
			{ level: LevelType.Paragraph, token: "1" },
			{ level: LevelType.Clause, token: "i" },
		]);

		stack.applyMarker(marker("2", LevelType.Paragraph));

		expect(stack.markers).toEqual([
			{ level: LevelType.Subsection, token: "a" },
			{ level: LevelType.Paragraph, token: "2" },
		]);
	});

	it("applies sibling-progression penalty for invalid continuation", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "a" },
		]);
		const penalty = stack.consistencyPenalty(
			marker("d", LevelType.Subsection),
			{ largeIndentDecrease: false } as unknown as Parameters<
				HierarchyStack["consistencyPenalty"]
			>[1],
		);

		expect(penalty).toBeLessThanOrEqual(-4);
	});

	it("treats (i) as clause in deep marker context", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "b" },
			{ level: LevelType.Paragraph, token: "1" },
			{ level: LevelType.Subparagraph, token: "A" },
		]);

		expect(stack.continuationRelation(marker("i", LevelType.Subsection))).toBe(
			"descend",
		);

		stack.applyMarker(marker("i", LevelType.Subsection));
		expect(stack.markers[stack.markers.length - 1]).toEqual({
			level: LevelType.Clause,
			token: "i",
		});
	});

	it("keeps (i) as subsection when not in deep marker context", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "h" },
		]);

		expect(stack.continuationRelation(marker("i", LevelType.Subsection))).toBe(
			"sibling",
		);

		stack.applyMarker(marker("i", LevelType.Subsection));
		expect(stack.markers[stack.markers.length - 1]).toEqual({
			level: LevelType.Subsection,
			token: "i",
		});
	});

	it("treats (I) as subclause in deep marker context", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "b" },
			{ level: LevelType.Paragraph, token: "1" },
			{ level: LevelType.Subparagraph, token: "A" },
			{ level: LevelType.Clause, token: "i" },
		]);

		expect(
			stack.continuationRelation(marker("I", LevelType.Subparagraph)),
		).toBe("descend");

		stack.applyMarker(marker("I", LevelType.Subparagraph));
		expect(stack.markers[stack.markers.length - 1]).toEqual({
			level: LevelType.Subclause,
			token: "I",
		});
	});

	it("keeps (I) as subparagraph when not in deep marker context", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subparagraph, token: "H" },
		]);

		expect(
			stack.continuationRelation(marker("I", LevelType.Subparagraph)),
		).toBe("sibling");

		stack.applyMarker(marker("I", LevelType.Subparagraph));
		expect(stack.markers[stack.markers.length - 1]).toEqual({
			level: LevelType.Subparagraph,
			token: "I",
		});
	});

	it("treats aa -> bb as valid item sibling progression", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "b" },
			{ level: LevelType.Paragraph, token: "1" },
			{ level: LevelType.Subparagraph, token: "A" },
			{ level: LevelType.Clause, token: "i" },
			{ level: LevelType.Subclause, token: "I" },
			{ level: LevelType.Item, token: "aa" },
		]);

		expect(stack.continuationRelation(marker("bb", LevelType.Item))).toBe(
			"sibling",
		);
	});

	it("treats i -> ii as clause siblings in deep context", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "b" },
			{ level: LevelType.Paragraph, token: "1" },
			{ level: LevelType.Subparagraph, token: "A" },
			{ level: LevelType.Clause, token: "i" },
		]);

		expect(stack.continuationRelation(marker("ii", LevelType.Clause))).toBe(
			"sibling",
		);
	});

	it("does not treat subsection i -> clause ii as sibling progression", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "i" },
		]);

		expect(
			stack.continuationRelation(marker("ii", LevelType.Clause)),
		).toBeNull();
	});

	it("treats I -> II as subclause siblings in deep context", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subsection, token: "b" },
			{ level: LevelType.Paragraph, token: "1" },
			{ level: LevelType.Subparagraph, token: "A" },
			{ level: LevelType.Clause, token: "i" },
			{ level: LevelType.Subclause, token: "I" },
		]);

		expect(stack.continuationRelation(marker("II", LevelType.Subclause))).toBe(
			"sibling",
		);
	});

	it("does not treat subparagraph I -> subclause II as sibling progression", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Subparagraph, token: "I" },
		]);

		expect(
			stack.continuationRelation(marker("II", LevelType.Subclause)),
		).toBeNull();
	});

	it("treats chained (A)(i) as descend and resolves tail to clause", () => {
		const stack = new HierarchyStack([
			{ level: LevelType.Paragraph, token: "3" },
		]);
		const chained = marker("i", LevelType.Subsection, [
			{ token: "A", level: LevelType.Subparagraph },
			{ token: "i", level: LevelType.Subsection },
		]);

		expect(stack.continuationRelation(chained)).toBe("descend");

		stack.applyMarker(chained);
		expect(stack.markers[stack.markers.length - 1]).toEqual({
			level: LevelType.Clause,
			token: "i",
		});
	});
});
