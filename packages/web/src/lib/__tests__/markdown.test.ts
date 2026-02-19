import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown";

describe("renderMarkdown", () => {
	it("renders quoted paragraphs with indent classes", () => {
		const rendered = renderMarkdown(
			[
				"> (19) REFERENCE PRICE.",
				"> > (A) IN GENERAL.",
				"> > > (i) For wheat, $6.35 per bushel.",
			].join("\n"),
		);

		expect(rendered).toContain('<p class="indent1">(19) REFERENCE PRICE.</p>');
		expect(rendered).toContain('<p class="indent2">(A) IN GENERAL.</p>');
		expect(rendered).toContain(
			'<p class="indent3">(i) For wheat, $6.35 per bushel.</p>',
		);
		expect(rendered).not.toContain("<blockquote>");
	});

	it("rewrites statute links against route prefix", () => {
		const rendered = renderMarkdown("[link](/statutes/usc/section/7/2014)", {
			statuteRoutePrefix: "/preview/statutes",
			sourceCode: "usc",
		});
		expect(rendered).toContain('href="/preview/statutes/section/7/2014"');
	});

	it("renders inline replacement ranges as ins/del without markdown delimiters", () => {
		const markdown = "This is old text.";
		const start = markdown.indexOf("old");
		const end = start + "old".length;
		const rendered = renderMarkdown(markdown, {
			replacements: [{ start, end, deletedText: "legacy" }],
		});

		expect(rendered).toContain(
			'<del class="pdf-amended-snippet-deleted">legacy</del>',
		);
		expect(rendered).toContain(
			'<ins class="pdf-amended-snippet-inserted">old</ins>',
		);
	});

	it("renders deletion-only anchors", () => {
		const markdown = "alpha beta";
		const anchor = markdown.indexOf("beta");
		const rendered = renderMarkdown(markdown, {
			replacements: [{ start: anchor, end: anchor, deletedText: "deleted" }],
		});

		expect(rendered).toContain(
			'<del class="pdf-amended-snippet-deleted">deleted</del>beta',
		);
	});

	it("preserves line breaks inside inserted replacements", () => {
		const markdown = "line1\nline2\nline3";
		const rendered = renderMarkdown(markdown, {
			replacements: [{ start: 0, end: markdown.length, deletedText: "" }],
		});

		expect(rendered).toContain(
			'<p class="indent0"><ins class="pdf-amended-snippet-inserted">line1</ins></p>',
		);
		expect(rendered).toContain(
			'<p class="indent0"><ins class="pdf-amended-snippet-inserted">line2</ins></p>',
		);
		expect(rendered).toContain(
			'<p class="indent0"><ins class="pdf-amended-snippet-inserted">line3</ins></p>',
		);
	});

	it("bolds inserted marker headings in AST while keeping .— outside bold", () => {
		const markdown = "(B) TIMING.—In carrying out";
		const rendered = renderMarkdown(markdown, {
			replacements: [{ start: 0, end: markdown.length, deletedText: "" }],
		});

		expect(rendered).toContain(
			"<strong>(B)</strong> <strong>TIMING</strong>.—In carrying out",
		);
	});
});
