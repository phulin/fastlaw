import { describe, expect, it } from "vitest";
import { resolveInsertionRanges } from "../text-spans";

describe("resolveInsertionRanges", () => {
	it("resolves insertion ranges in source order", () => {
		const source = "alpha beta gamma beta";
		const ranges = resolveInsertionRanges(source, ["beta", "beta"]);
		expect(ranges).toEqual([
			{ start: 6, end: 10 },
			{ start: 17, end: 21 },
		]);
	});

	it("matches trimmed and newline-normalized candidates", () => {
		const source = "prefix\nvalue\n\nsuffix";
		const ranges = resolveInsertionRanges(source, ["\nvalue\n"]);
		expect(ranges).toEqual([{ start: 6, end: 13 }]);
	});

	it("skips insertions that cannot be matched", () => {
		const source = "alpha beta";
		const ranges = resolveInsertionRanges(source, ["missing", "beta"]);
		expect(ranges).toEqual([{ start: 6, end: 10 }]);
	});
});
