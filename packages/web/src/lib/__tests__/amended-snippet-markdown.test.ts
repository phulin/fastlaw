import { describe, expect, it } from "vitest";
import { buildHighlightedSnippetMarkdown } from "../amended-snippet-markdown";
import type { AmendmentEffect } from "../amendment-edit-tree-apply";

const buildEffect = (
	text: string,
	replacements: AmendmentEffect["replacements"],
): AmendmentEffect => ({
	status: "ok",
	sectionPath: "/statutes/usc/section/1/1",
	segments: [{ kind: "unchanged", text }],
	changes: [],
	deleted: [],
	inserted: [],
	replacements,
	applySummary: {
		partiallyApplied: false,
		failedItems: [],
	},
	debug: {
		sectionTextLength: text.length,
		operationCount: 1,
		operationAttempts: [],
		failureReason: null,
		pipeline: {
			resolvedOperationCount: 1,
			plannedPatchCount: replacements?.length ?? 0,
			resolutionIssueCount: 0,
			resolutionIssues: [],
		},
	},
});

describe("buildHighlightedSnippetMarkdown", () => {
	it("uses 5 paragraph context windows for HTML paragraphs", () => {
		const paragraphs = Array.from(
			{ length: 20 },
			(_, index) => `<p>Paragraph ${index + 1}</p>`,
		);
		const text = paragraphs.join("");
		const target = "Paragraph 10";
		const start = text.indexOf(target);
		const end = start + target.length;
		const effect = buildEffect(text, [
			{ start, end, deletedText: "Paragraph old" },
		]);

		const snippet = buildHighlightedSnippetMarkdown(effect, 5);

		expect(snippet.markdown).toContain("<p>Paragraph 5</p>");
		expect(snippet.markdown).toContain("<p>Paragraph 15</p>");
		expect(snippet.markdown).not.toContain("<p>Paragraph 4</p>");
		expect(snippet.markdown).not.toContain("<p>Paragraph 16</p>");
		expect(snippet.replacements).toHaveLength(1);
	});
});
