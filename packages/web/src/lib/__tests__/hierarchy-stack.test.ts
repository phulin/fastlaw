import { describe, expect, it } from "vitest";
import { HierarchyEntry, HierarchyStack, LevelType } from "../hierarchy-stack";

function entry(level: LevelType, token: string): HierarchyEntry {
	const parsed = HierarchyEntry.make(level, token);
	if (!parsed) throw new Error(`Invalid test entry: ${token}`);
	return parsed;
}

function features(
	overrides: Partial<Parameters<HierarchyStack["consistencyPenalty"]>[1]> = {},
): Parameters<HierarchyStack["consistencyPenalty"]>[1] {
	return {
		largeIndentDecrease: false,
		...overrides,
	};
}

describe("HierarchyStack", () => {
	it("covers all continuation relation outcomes", () => {
		const descendStack = new HierarchyStack();
		expect(
			descendStack.continuationRelation([entry(LevelType.Subsection, "a")]),
		).toBe("descend");

		const siblingStack = new HierarchyStack([entry(LevelType.Subsection, "a")]);
		expect(
			siblingStack.continuationRelation([entry(LevelType.Subsection, "b")]),
		).toBe("sibling");

		const ascendStack = new HierarchyStack([
			entry(LevelType.Paragraph, "3"),
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
		]);
		expect(
			ascendStack.continuationRelation([entry(LevelType.Subsection, "c")]),
		).toBe("ascend");

		const nullStack = new HierarchyStack([entry(LevelType.Subsection, "a")]);
		expect(
			nullStack.continuationRelation([entry(LevelType.Subsection, "d")]),
		).toBeNull();
	});

	it("treats a first marker as descend for empty stacks", () => {
		const stack = new HierarchyStack();

		expect(stack.continuationRelation([entry(LevelType.Subsection, "a")])).toBe(
			"descend",
		);
	});

	it("tracks empty/non-empty state and finds marker at level", () => {
		const stack = new HierarchyStack();
		expect(stack.isEmpty()).toBe(true);

		stack.applyChain([entry(LevelType.Subsection, "a")]);
		stack.applyChain([entry(LevelType.Subsection, "b")]);
		expect(stack.isEmpty()).toBe(false);

		expect(stack.findLastAtLevel(LevelType.Subsection)).toEqual(
			entry(LevelType.Subsection, "b"),
		);
		expect(stack.findLastAtLevel(LevelType.Item)).toBeNull();
	});

	it("clones by value so later mutations do not leak between instances", () => {
		const original = new HierarchyStack([entry(LevelType.Subsection, "a")]);
		const copy = original.clone();

		copy.applyChain([entry(LevelType.Paragraph, "1")]);

		expect(original.entries).toEqual([entry(LevelType.Subsection, "a")]);
		expect(copy.entries).toEqual([
			entry(LevelType.Subsection, "a"),
			entry(LevelType.Paragraph, "1"),
		]);
	});

	it("detects sibling and descend continuation relations", () => {
		const stack = new HierarchyStack([entry(LevelType.Subsection, "a")]);

		expect(stack.continuationRelation([entry(LevelType.Subsection, "b")])).toBe(
			"sibling",
		);
		expect(stack.continuationRelation([entry(LevelType.Paragraph, "1")])).toBe(
			"descend",
		);
	});

	it("applies marker updates by popping same-or-deeper levels", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "a"),
			entry(LevelType.Paragraph, "1"),
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
		]);

		stack.applyChain([entry(LevelType.Paragraph, "2")]);

		expect(stack.entries).toEqual([
			entry(LevelType.Subsection, "a"),
			entry(LevelType.Paragraph, "2"),
		]);
	});

	it("returns null for invalid chain shapes", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "b"),
			entry(LevelType.Paragraph, "1"),
		]);

		expect(
			stack.continuationRelation([
				entry(LevelType.Subparagraph, "D"),
				entry(LevelType.Clause, "ii"),
			]),
		).toBeNull();
	});

	it("throws for empty continuation chain", () => {
		const stack = new HierarchyStack();

		expect(() => stack.continuationRelation([])).toThrow(
			"Can't resolve empty chain.",
		);
	});

	it("applies sibling-progression penalty for invalid continuation", () => {
		const stack = new HierarchyStack([entry(LevelType.Subsection, "a")]);

		expect(stack.consistencyPenalty(["d"], features())).toBeLessThanOrEqual(-4);
	});

	it("applies deeper-than-adjacent level penalty", () => {
		const stack = new HierarchyStack([entry(LevelType.Subsection, "a")]);

		expect(stack.consistencyPenalty(["A"], features())).toBeLessThanOrEqual(-6);
	});

	it("applies steep-ascend penalty unless there is a large indent decrease", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
		]);

		const withoutIndentCue = stack.consistencyPenalty(
			["1"],
			features({ largeIndentDecrease: false }),
		);
		const withIndentCue = stack.consistencyPenalty(
			["1"],
			features({ largeIndentDecrease: true }),
		);

		expect(withoutIndentCue).toBeLessThan(withIndentCue);
	});

	it("applies strong penalty for numeric regressions", () => {
		const stack = new HierarchyStack([entry(LevelType.Paragraph, "10")]);

		expect(stack.consistencyPenalty(["9"], features())).toBeLessThanOrEqual(
			-12,
		);
	});

	it("penalizes descending into a non-first child marker", () => {
		const stack = new HierarchyStack([entry(LevelType.Subsection, "a")]);

		expect(stack.consistencyPenalty(["2"], features())).toBeLessThanOrEqual(-2);
	});

	it("resolves i as clause in deep marker context", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "b"),
			entry(LevelType.Paragraph, "1"),
			entry(LevelType.Subparagraph, "A"),
		]);

		expect(stack.resolveMarkersInContext(["i"])).toEqual([
			entry(LevelType.Clause, "i"),
		]);
	});

	it("keeps i as subsection when not in deep marker context", () => {
		const stack = new HierarchyStack([entry(LevelType.Subsection, "h")]);

		expect(stack.resolveMarkersInContext(["i"])).toEqual([
			entry(LevelType.Subsection, "i"),
		]);
	});

	it("treats aa -> bb as valid item sibling progression", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "b"),
			entry(LevelType.Paragraph, "1"),
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
			entry(LevelType.Subclause, "I"),
			entry(LevelType.Item, "aa"),
		]);

		expect(stack.continuationRelation([entry(LevelType.Item, "bb")])).toBe(
			"sibling",
		);
	});

	it("treats II -> aa as a valid descend into first item", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "b"),
			entry(LevelType.Paragraph, "1"),
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
			entry(LevelType.Subclause, "II"),
		]);

		expect(stack.continuationRelation([entry(LevelType.Item, "aa")])).toBe(
			"descend",
		);
	});

	it("treats i -> ii as clause siblings in deep context", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "b"),
			entry(LevelType.Paragraph, "1"),
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
		]);

		expect(stack.continuationRelation([entry(LevelType.Clause, "ii")])).toBe(
			"sibling",
		);
	});

	it("does not treat subsection i -> clause ii as sibling progression", () => {
		const stack = new HierarchyStack([entry(LevelType.Subsection, "i")]);

		expect(
			stack.continuationRelation([entry(LevelType.Clause, "ii")]),
		).toBeNull();
	});

	it("returns ascend when continuation goes above current head", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Paragraph, "3"),
			entry(LevelType.Subparagraph, "A"),
			entry(LevelType.Clause, "i"),
		]);

		expect(stack.continuationRelation([entry(LevelType.Subsection, "c")])).toBe(
			"ascend",
		);
	});

	it("resolves C as subparagraph sibling after (B)(ii)", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "a"),
			entry(LevelType.Paragraph, "1"),
			entry(LevelType.Subparagraph, "B"),
			entry(LevelType.Clause, "ii"),
		]);

		expect(stack.resolveMarkersInContext(["C"])).toEqual([
			entry(LevelType.Subparagraph, "C"),
		]);
	});

	it("allows sparse stack levels", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Section, "1"),
			entry(LevelType.Paragraph, "1"),
		]);

		expect(stack.entries).toEqual([
			entry(LevelType.Section, "1"),
			entry(LevelType.Paragraph, "1"),
		]);
	});

	it("uses nearest parent when ascending without an exact level match", () => {
		const stack = new HierarchyStack([
			entry(LevelType.Subsection, "a"),
			entry(LevelType.Clause, "ii"),
		]);

		expect(
			stack.continuationRelation([entry(LevelType.Subparagraph, "A")]),
		).toBe("ascend");
	});
});
