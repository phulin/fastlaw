import { describe, expect, it } from "vitest";
import { injectInlineReplacements } from "../text-spans";

describe("injectInlineReplacements", () => {
	it("wraps multiline insertions with ++ delimiters", () => {
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
			"\n++\n> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
		);
		expect(rendered).toContain("\n\n> > **(A)** a partnership;\n++\n");
		expect(rendered).toContain(
			"> **(5)** **QUALIFIED PASS-THROUGH ENTITY**\n\n> The term 'qualified pass-through entity' means—",
		);
	});

	it("renders multiline replacements with separate ~~ and ++ blocks", () => {
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
			[
				{
					start,
					end,
					deletedText: "legacy deleted block",
				},
			],
			{
				insertedClassName: "pdf-amended-snippet-inserted",
				deletedClassName: "pdf-amended-snippet-deleted",
				addSpaceBeforeIfNeeded: true,
			},
		);

		expect(rendered).toContain("~~\nlegacy deleted block\n~~");
		expect(rendered).toContain(
			"++\n> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
		);
		expect(rendered).toContain("~~\n\n++");
	});

	it("uses block delimiters for full-line replacements even when single-line", () => {
		const source = "prefix\nnew text\nsuffix";
		const start = source.indexOf("new text");
		const end = start + "new text".length;
		const rendered = injectInlineReplacements(
			source,
			[
				{
					start,
					end,
					deletedText: "\nBLOCK_TEXT",
				},
			],
			{
				insertedClassName: "pdf-amended-snippet-inserted",
				deletedClassName: "pdf-amended-snippet-deleted",
				addSpaceBeforeIfNeeded: true,
			},
		);

		expect(rendered).toContain("~~\nBLOCK_TEXT\n~~");
		expect(rendered).toContain("++\nnew text\n++");
	});

	it("injects deletion-only text at zero-width anchor ranges", () => {
		const source = "alpha beta";
		const anchor = source.indexOf("beta");
		const rendered = injectInlineReplacements(
			source,
			[
				{
					start: anchor,
					end: anchor,
					deletedText: "deleted words",
				},
			],
			{
				insertedClassName: "pdf-amended-snippet-inserted",
				deletedClassName: "pdf-amended-snippet-deleted",
				addSpaceBeforeIfNeeded: true,
			},
		);

		expect(rendered).toContain("alpha ~~deleted words~~beta");
		expect(rendered).not.toContain("++++");
	});
});
