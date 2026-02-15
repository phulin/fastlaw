import { describe, expect, it } from "vitest";
import { injectInlineReplacements } from "../text-spans";

describe("injectInlineReplacements", () => {
	it("wraps multiline insertions as block ins elements", () => {
		const source = [
			'The term "person" means a natural person.',
			"> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
			"> The term 'qualified pass-through entity' means—",
			"> > **(A)** a partnership;",
			"tail",
		].join("\n");

		const start = source.indexOf("> **(5)** **QUALIFIED PASS-THROUGH ENTITY**");
		const end = source.indexOf("\ntail");
		const rendered = injectInlineReplacements(
			source,
			[{ start, end, deletedText: "" }],
			{
				insertedClassName: "pdf-amended-snippet-inserted",
				deletedClassName: "pdf-amended-snippet-deleted",
				addSpaceBeforeIfNeeded: true,
			},
		);

		expect(rendered).toContain(
			'\n\n<ins class="pdf-amended-snippet-inserted">\n> **(5)** **QUALIFIED PASS-THROUGH ENTITY**',
		);
		expect(rendered).toContain("> > **(A)** a partnership;\n</ins>\n\n");
	});
});
