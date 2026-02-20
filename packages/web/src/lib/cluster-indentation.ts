import type { Paragraph } from "./types";

const FIXED_CLUSTER_UPPER_BOUNDS = [171, 199, 227, 255, 283, 311] as const;

/**
 * Assigns indentation levels using fixed x-position buckets.
 *
 * Buckets:
 * - level 0: x < 171
 * - level 1: 171 <= x < 199
 * - level 2: 199 <= x < 227
 * - level 3: 227 <= x < 255
 * - level 4: 255 <= x < 283
 * - level 5: 283 <= x < 311
 * - level 6: x >= 311
 */
export function assignIndentationLevels(paragraphs: Paragraph[]): Paragraph[] {
	return paragraphs.map((paragraph) => {
		const xStart = paragraph.lines[0].xStart;
		const level = FIXED_CLUSTER_UPPER_BOUNDS.findIndex((upperBound) => {
			return xStart < upperBound;
		});

		return {
			...paragraph,
			level: level === -1 ? FIXED_CLUSTER_UPPER_BOUNDS.length : level,
		};
	});
}
