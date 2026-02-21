import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";
import { renderAmendedSnippet } from "../amended-snippet-render";
import type {
	FormattingSpan,
	OperationMatchAttempt,
	ResolutionIssue,
} from "../amendment-edit-engine-types";
import type { AmendmentEffect } from "../amendment-edit-tree-apply";

function buildEffect(
	plainText: string,
	spans: FormattingSpan[],
): AmendmentEffect {
	return {
		status: "ok",
		sectionPath: "/statutes/usc/section/1/1",
		renderModel: { plainText, spans },
		segments: [{ kind: "unchanged", text: plainText }],
		changes: [],
		deleted: [],
		inserted: [],
		applySummary: {
			partiallyApplied: false,
			failedItems: [],
		},
		debug: {
			sectionTextLength: plainText.length,
			operationCount: 1,
			operationAttempts: [] as OperationMatchAttempt[],
			failureReason: null,
			pipeline: {
				resolvedOperationCount: 1,
				plannedPatchCount: 0,
				resolutionIssueCount: 0,
				resolutionIssues: [] as ResolutionIssue[],
			},
		},
	};
}

function renderEffect(plainText: string, spans: FormattingSpan[]): string {
	const effect = buildEffect(plainText, spans);
	return renderToString(() => <div>{renderAmendedSnippet(effect)}</div>)
		.replace(/\sdata-hk="[^"]*"/g, "")
		.replace(/></g, ">\n<");
}

describe("renderAmendedSnippet", () => {
	it("renders multiple paragraph spans as paragraph blocks", () => {
		const plainText = "Alpha\n\nBeta";
		const html = renderEffect(plainText, [
			{ start: 0, end: 5, type: "paragraph" },
			{ start: 7, end: 11, type: "paragraph" },
		]);

		expect(html).toContain("<p>Alpha</p>");
		expect(html).toContain("<p>Beta</p>");
	});

	it("renders heading paragraphs with quote-depth class", () => {
		const plainText = "Header";
		const html = renderEffect(plainText, [
			{
				start: 0,
				end: plainText.length,
				type: "paragraph",
				metadata: { quoteDepth: 2 },
			},
			{
				start: 0,
				end: plainText.length,
				type: "heading",
				metadata: { depth: 3 },
			},
		]);

		expect(html).toContain('<h3 class="indent2">Header</h3>');
	});

	it("renders quote depth from blockquote spans when paragraph metadata is absent", () => {
		const plainText = "Quoted";
		const html = renderEffect(plainText, [
			{ start: 0, end: plainText.length, type: "paragraph" },
			{
				start: 0,
				end: plainText.length,
				type: "blockquote",
				metadata: { depth: 4 },
			},
		]);

		expect(html).toContain('<p class="indent4">Quoted</p>');
	});

	it("renders inline strong, emphasis, code, insertion and deletion spans", () => {
		const plainText = "Alpha Beta Gamma Delta Epsilon";
		const alphaEnd = plainText.indexOf(" ");
		const betaStart = plainText.indexOf("Beta");
		const betaEnd = betaStart + "Beta".length;
		const gammaStart = plainText.indexOf("Gamma");
		const gammaEnd = gammaStart + "Gamma".length;
		const deltaStart = plainText.indexOf("Delta");
		const deltaEnd = deltaStart + "Delta".length;
		const epsilonStart = plainText.indexOf("Epsilon");
		const epsilonEnd = epsilonStart + "Epsilon".length;
		const html = renderEffect(plainText, [
			{ start: 0, end: plainText.length, type: "paragraph" },
			{ start: 0, end: alphaEnd, type: "strong" },
			{ start: betaStart, end: betaEnd, type: "emphasis" },
			{ start: gammaStart, end: gammaEnd, type: "inlineCode" },
			{ start: deltaStart, end: deltaEnd, type: "insertion" },
			{ start: epsilonStart, end: epsilonEnd, type: "deletion" },
		]);

		expect(html).toContain("<strong>Alpha</strong>");
		expect(html).toContain("<em>Beta</em>");
		expect(html).toContain("<code>Gamma</code>");
		expect(html).toContain("<ins>Delta</ins>");
		expect(html).toContain("<del>Epsilon</del>");
	});

	it("renders links as the outer wrapper over other inline styles", () => {
		const plainText = "Click here";
		const start = plainText.indexOf("here");
		const end = start + "here".length;
		const html = renderEffect(plainText, [
			{ start: 0, end: plainText.length, type: "paragraph" },
			{
				start,
				end,
				type: "link",
				metadata: { href: "/statutes/section/7/2014" },
			},
			{ start, end, type: "strong" },
		]);

		expect(html).toMatch(
			/<a href="\/statutes\/section\/7\/2014">\s*<strong>here<\/strong>\s*<\/a>/,
		);
	});

	it("renders hard line breaks as br tags", () => {
		const plainText = "line 1\nline 2";
		const html = renderEffect(plainText, [
			{ start: 0, end: plainText.length, type: "paragraph" },
		]);

		expect(html).toContain("line 1<br>line 2");
	});

	it("renders one paragraph when no paragraph spans are present", () => {
		const plainText = "Fallback paragraph";
		const html = renderEffect(plainText, []);

		expect(html).toContain("<p>Fallback paragraph</p>");
	});

	it("escapes text content by default", () => {
		const plainText = "<script>alert(1)</script>";
		const html = renderEffect(plainText, [
			{ start: 0, end: plainText.length, type: "paragraph" },
		]);

		expect(html).toContain("&lt;script>alert(1)&lt;/script>");
		expect(html).not.toContain("<script>alert(1)</script>");
	});
});
