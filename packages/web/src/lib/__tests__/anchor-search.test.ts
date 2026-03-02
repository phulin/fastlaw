import { describe, expect, it } from "vitest";
import { findAnchorSearchMatch } from "../anchor-search";

const INSIDE_WORD_HYPHEN_RE = /(?<=[A-Za-z0-9])-(?=[A-Za-z0-9])/g;

describe("findAnchorSearchMatch", () => {
	it("matches literal text when no ignore patterns are provided", () => {
		const match = findAnchorSearchMatch("alpha beta", "beta");
		expect(match).toEqual({ index: 6, matchedText: "beta" });
	});

	it("matches when ignored text appears only in haystack", () => {
		const match = findAnchorSearchMatch("tax-payer relief", "taxpayer", {
			ignoreInHaystack: INSIDE_WORD_HYPHEN_RE,
			ignoreInNeedle: INSIDE_WORD_HYPHEN_RE,
		});
		expect(match).toEqual({ index: 0, matchedText: "tax-payer" });
	});

	it("matches when ignored text appears only in needle", () => {
		const match = findAnchorSearchMatch("taxpayer relief", "tax-payer", {
			ignoreInHaystack: INSIDE_WORD_HYPHEN_RE,
			ignoreInNeedle: INSIDE_WORD_HYPHEN_RE,
		});
		expect(match).toEqual({ index: 0, matchedText: "taxpayer" });
	});

	it("matches case-insensitively when requested", () => {
		const match = findAnchorSearchMatch("Alpha Beta", "beta", {
			caseInsensitive: true,
		});
		expect(match).toEqual({ index: 6, matchedText: "Beta" });
	});
});
