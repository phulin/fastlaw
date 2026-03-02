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

	it("matches across codification paragraph breaks for period-dash anchors", () => {
		const match = findAnchorSearchMatch(
			'by striking "BENEFITS.\nNo deduction"',
			'by striking "BENEFITS.\u2014No deduction"',
			{
				caseInsensitive: true,
			},
		);
		expect(match).toEqual({
			index: 0,
			matchedText: 'by striking "BENEFITS.\nNo deduction"',
		});
	});

	it("matches across underscore placeholder after period", () => {
		const match = findAnchorSearchMatch(
			'by striking "BENEFITS._No deduction"',
			'by striking "BENEFITS.\u2014No deduction"',
			{
				caseInsensitive: true,
			},
		);
		expect(match).toEqual({
			index: 0,
			matchedText: 'by striking "BENEFITS._No deduction"',
		});
	});

	it("matches across paragraph separator after period", () => {
		const match = findAnchorSearchMatch(
			'by striking "BENEFITS.\u2029No deduction"',
			'by striking "BENEFITS.\u2014No deduction"',
			{
				caseInsensitive: true,
			},
		);
		expect(match).toEqual({
			index: 0,
			matchedText: 'by striking "BENEFITS.\u2029No deduction"',
		});
	});

	it("matches .— against plain paragraph newline without period", () => {
		const match = findAnchorSearchMatch(
			'by striking "BENEFITS\nNo deduction"',
			'by striking "BENEFITS.\u2014No deduction"',
			{
				caseInsensitive: true,
			},
		);
		expect(match).toEqual({
			index: 0,
			matchedText: 'by striking "BENEFITS\nNo deduction"',
		});
	});
});
