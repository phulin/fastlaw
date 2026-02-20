import { describe, expect, it } from "vitest";
import { splitParagraphsRulesBased } from "../rules-paragraph-condenser-3";
import type { Line } from "../types";

function line(
	text: string,
	xStart: number,
	xEnd: number,
	lineIndex: number,
): Line {
	return {
		page: 1,
		text,
		xStart,
		xEnd,
		y: 700 - lineIndex * 12,
		yStart: 714 - lineIndex * 12,
		yEnd: 700 - lineIndex * 12,
		items: [],
		isBold: false,
		pageHeight: 792,
	};
}

describe("splitParagraphsRulesBased", () => {
	it("splits after a section heading when the next line is not mostly caps", () => {
		const lines: Line[] = [
			line("SEC. 90001. BORDER INFRASTRUCTURE AND WALL SYSTEM.", 150, 500, 0),
			line("In addition to amounts otherwise available, there is", 178, 486, 1),
			line("appropriated to the Commissioner of U.S. Customs and", 150, 486, 2),
		];

		const paragraphs = splitParagraphsRulesBased(lines);

		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0]?.text).toBe(
			"SEC. 90001. BORDER INFRASTRUCTURE AND WALL SYSTEM. In addition to amounts otherwise available, there is",
		);
		expect(paragraphs[1]?.text).toBe(
			"appropriated to the Commissioner of U.S. Customs and",
		);
	});

	it("does not force a split when the next line is mostly caps", () => {
		const lines: Line[] = [
			line("SEC. 90001. BORDER INFRASTRUCTURE AND WALL SYSTEM.", 150, 500, 0),
			line("(a) IN GENERAL.—", 178, 300, 1),
			line("IN ADDITION TO AMOUNTS OTHERWISE AVAILABLE,", 178, 486, 2),
		];

		const paragraphs = splitParagraphsRulesBased(lines);

		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0]?.text).toBe(
			"SEC. 90001. BORDER INFRASTRUCTURE AND WALL SYSTEM. (a) IN GENERAL.—",
		);
		expect(paragraphs[1]?.text).toBe(
			"IN ADDITION TO AMOUNTS OTHERWISE AVAILABLE,",
		);
	});
});
