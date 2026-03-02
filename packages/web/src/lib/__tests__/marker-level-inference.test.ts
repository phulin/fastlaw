import { describe, expect, it } from "vitest";
import { buildInferredMarkerLevels } from "../marker-level-inference";

describe("marker-level-inference", () => {
	it("keeps multi-letter uppercase markers at subparagraph level", () => {
		const levels = buildInferredMarkerLevels([
			{ markers: ["A", "B", "Z", "AA", "LL", "MM"], indentationHint: 2 },
		])[0];
		expect(levels?.map((level) => level.type)).toEqual([
			"subparagraph",
			"subparagraph",
			"subparagraph",
			"subparagraph",
			"subparagraph",
			"subparagraph",
		]);
	});

	it("keeps multi-letter uppercase markers as items in deep item contexts", () => {
		const levels = buildInferredMarkerLevels([
			{ markers: ["A", "i", "I", "a", "AA", "BB"], indentationHint: 6 },
		])[0];
		expect(levels?.map((level) => level.type)).toEqual([
			"subparagraph",
			"clause",
			"subclause",
			"item",
			"item",
			"item",
		]);
	});
});
