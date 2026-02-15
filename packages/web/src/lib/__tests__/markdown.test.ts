import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown";

describe("renderMarkdown", () => {
	it("renders quoted paragraphs with indent classes and no nested indent divs", () => {
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
		expect(rendered).not.toContain('<div class="indent');
	});

	it("renders quoted paragraphs inside ++ blocks as p.indentX", () => {
		const rendered = renderMarkdown(
			[
				"++",
				"> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
				"> The term 'qualified pass-through entity' means—",
				"> > **(A)** a partnership;",
				"> > **(B)** an S corporation;",
				"> > **(C)** a limited liability company; and",
				"> > **(D)** a joint venture or general partnership.",
				"++",
			].join("\n"),
		);

		expect(rendered).toContain('<ins class="pdf-amended-snippet-inserted">');
		expect(rendered).toContain(
			"<strong>(5)</strong> <strong>QUALIFIED PASS-THROUGH ENTITY</strong>",
		);
		expect(rendered).toContain(
			"The term &#39;qualified pass-through entity&#39; means—",
		);
		expect(rendered).toContain("<strong>(A)</strong> a partnership;");
		expect(rendered).toContain("<strong>(B)</strong> an S corporation;");
		expect(rendered).toContain(
			"<strong>(C)</strong> a limited liability company; and",
		);
		expect(rendered).toContain(
			"<strong>(D)</strong> a joint venture or general partnership.",
		);
		expect(rendered).not.toContain('<div class="indent');
	});

	it("renders ~~ as del", () => {
		const rendered = renderMarkdown("~~old text~~ ++new text++");
		expect(rendered).toContain(
			'<del class="pdf-amended-snippet-deleted">old text</del>',
		);
		expect(rendered).toContain(
			'<ins class="pdf-amended-snippet-inserted">new text</ins>',
		);
	});

	it("renders block ~~ and block ++ delimiters", () => {
		const rendered = renderMarkdown("~~\nold block\n~~\n\n++\nnew block\n++");
		expect(rendered).toContain(
			'<del class="pdf-amended-snippet-deleted"><p class="indent0">old block</p>',
		);
		expect(rendered).toContain(
			'<ins class="pdf-amended-snippet-inserted"><p class="indent0">new block</p>',
		);
	});
});
