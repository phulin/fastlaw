import { describe, expect, it } from "vitest";
import { assignIndentationLevels } from "../cluster-indentation";
import type { Line, Paragraph } from "../text-extract";

describe("assignIndentationLevels", () => {
	function mockParagraph(indent: number, text: string): Paragraph {
		return {
			startPage: 1,
			endPage: 1,
			text,
			confidence: 1,
			y: 0,
			yStart: 0,
			yEnd: 0,
			pageHeight: 1000,
			lines: [
				{
					page: 1,
					y: 0,
					yStart: 0,
					yEnd: 0,
					xStart: indent,
					xEnd: indent + 100,
					text,
					items: [],
					pageHeight: 1000,
				} as Line,
			],
		};
	}

	it("should cluster paragraphs into levels", () => {
		const paragraphs: Paragraph[] = [];
		// Cluster 0: around 10
		for (let i = 0; i < 10; i++)
			paragraphs.push(mockParagraph(10 + i * 0.1, `C0-${i}`));
		// Cluster 1: around 50
		for (let i = 0; i < 10; i++)
			paragraphs.push(mockParagraph(50 + i * 0.1, `C1-${i}`));
		// Cluster 2: around 100
		for (let i = 0; i < 10; i++)
			paragraphs.push(mockParagraph(100 + i * 0.1, `C2-${i}`));

		const results = assignIndentationLevels(paragraphs);

		const levelCounts = new Set(results.map((p) => p.level)).size;
		expect(levelCounts).toBe(3);

		// Levels should be monotonically increasing with indentation
		for (let i = 0; i < results.length - 1; i++) {
			const p1 = results[i];
			const p2 = results[i + 1];
			expect(p1.level).toBeDefined();
			expect(p2.level).toBeDefined();
			expect(p1.level).toBeLessThanOrEqual(p2.level ?? 0);
		}
	});

	it("should handle empty input", () => {
		expect(assignIndentationLevels([])).toEqual([]);
	});

	it("should pick the best k within 3-7", () => {
		// Create 4 distinct clusters
		const paragraphs = [
			mockParagraph(10, "C1-A"),
			mockParagraph(11, "C1-B"),
			mockParagraph(50, "C2-A"),
			mockParagraph(51, "C2-B"),
			mockParagraph(100, "C3-A"),
			mockParagraph(101, "C3-B"),
			mockParagraph(150, "C4-A"),
			mockParagraph(151, "C4-B"),
		];

		const results = assignIndentationLevels(paragraphs);

		const levels = new Set(results.map((p) => p.level));
		expect(levels.size).toBe(4);

		// Group 1 (10, 11) -> Level 0
		expect(results[0].level).toBe(0);
		expect(results[1].level).toBe(0);
		// Group 2 (50, 51) -> Level 1
		expect(results[2].level).toBe(1);
		expect(results[3].level).toBe(1);
		// Group 3 (100, 101) -> Level 2
		expect(results[4].level).toBe(2);
		expect(results[5].level).toBe(2);
		// Group 4 (150, 151) -> Level 3
		expect(results[6].level).toBe(3);
		expect(results[7].level).toBe(3);
	});
});
