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

	it("renders quoted paragraphs inside ins blocks as p.indentX", () => {
		const rendered = renderMarkdown(
			[
				'<ins class="pdf-amended-snippet-inserted">',
				"> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
				"> The term 'qualified pass-through entity' means—",
				"> > **(A)** a partnership;",
				"> > **(B)** an S corporation;",
				"> > **(C)** a limited liability company; and",
				"> > **(D)** a joint venture or general partnership.",
				"</ins>",
			].join("\n"),
		);

		expect(rendered).toContain('<ins class="pdf-amended-snippet-inserted">');
		expect(rendered).toContain(
			'<p class="indent1"><strong>(5)</strong> <strong>QUALIFIED PASS-THROUGH ENTITY</strong></p>',
		);
		expect(rendered).toContain(
			'<p class="indent1">The term &#39;qualified pass-through entity&#39; means—</p>',
		);
		expect(rendered).toContain(
			'<p class="indent2"><strong>(A)</strong> a partnership;</p>',
		);
		expect(rendered).toContain(
			'<p class="indent2"><strong>(B)</strong> an S corporation;</p>',
		);
		expect(rendered).toContain(
			'<p class="indent2"><strong>(C)</strong> a limited liability company; and</p>',
		);
		expect(rendered).toContain(
			'<p class="indent2"><strong>(D)</strong> a joint venture or general partnership.</p>',
		);
		expect(rendered).not.toContain('<div class="indent');
	});
});
