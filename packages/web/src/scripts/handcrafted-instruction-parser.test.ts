import { describe, expect, it } from "vitest";
import { createHandcraftedInstructionParser } from "./handcrafted-instruction-parser";

describe("HandcraftedInstructionParser", () => {
	it("greedily consumes the longest instruction span from a start line", () => {
		const parser = createHandcraftedInstructionParser();
		const lines = [
			"Section 101 of title 10, United States Code, is amended—",
			"(1) by striking “A”; and",
			"(2) by striking “B”.",
			"Section 102 of title 10, United States Code, is amended by striking “C”.",
		];

		const parsed = parser.parseInstructionFromLines(lines, 0);

		expect(parsed).not.toBeNull();
		expect(parsed?.startIndex).toBe(0);
		expect(parsed?.endIndex).toBe(2);
		expect(parsed?.text).toContain("(2) by striking “B”.");
		expect(parsed?.text).not.toContain("Section 102");
	});

	it("parses act-containing locator forms", () => {
		const parser = createHandcraftedInstructionParser();
		const input = "The Commodity Exchange Act";

		const initialLocatorEnds = parser.parsePrefix(input, "initial_locator");

		expect(initialLocatorEnds).toContain(input.length);
	});
});
