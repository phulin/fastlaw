import { describe, expect, it } from "vitest";
import {
	findHierarchyNodeByMarkerPath,
	parseMarkdownHierarchy,
} from "../markdown-hierarchy-parser";

describe("parseMarkdownHierarchy", () => {
	it("parses heading, sublevels, and footing segments", () => {
		const markdown = [
			"**(a)** Alpha",
			"",
			"> intro for a",
			"",
			"> > **(1)** First child",
			"",
			"> > body for child 1",
			"",
			"> > **(2)** Second child",
			"",
			"> trailing for a",
			"",
			"**(b)** Beta",
			"",
			"> body for b",
		].join("\n");

		const parsed = parseMarkdownHierarchy(markdown);
		expect(parsed.levels.map((level) => level.marker)).toEqual(["a", "b"]);

		const a = parsed.levels[0];
		expect(a?.heading.map((paragraph) => paragraph.text)).toEqual([
			"**(a)** Alpha",
			"> intro for a",
		]);
		expect(a?.sublevels.map((level) => level.marker)).toEqual(["1", "2"]);
		expect(a?.footing.map((paragraph) => paragraph.text)).toEqual([
			"> trailing for a",
		]);
	});

	it("supports marker-path lookup", () => {
		const markdown = [
			"**(a)** Alpha",
			"",
			"> > **(1)** First child",
			"",
			"> > > **(A)** Grandchild",
			"",
			"> > > text",
		].join("\n");
		const parsed = parseMarkdownHierarchy(markdown);

		const node = findHierarchyNodeByMarkerPath(parsed.levels, ["a", "1", "A"]);
		expect(node?.marker).toBe("A");
		expect(node?.heading.map((paragraph) => paragraph.text)).toEqual([
			"> > > **(A)** Grandchild",
			"> > > text",
		]);
	});

	it("creates dense nested nodes for chained leading markers", () => {
		const markdown = [
			"> > **(11)** **(A)** chained heading",
			"",
			"> > > body",
		].join("\n");
		const parsed = parseMarkdownHierarchy(markdown);

		const first = parsed.levels[0];
		expect(first?.marker).toBe("11");
		expect(first?.sublevels.map((level) => level.marker)).toEqual(["A"]);
		const nested = first?.sublevels[0];
		expect(nested?.heading.map((paragraph) => paragraph.text)).toEqual([
			"> > **(11)** **(A)** chained heading",
			"> > > body",
		]);
		expect(first?.heading).toEqual([]);
	});
});
