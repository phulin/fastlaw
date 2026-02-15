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
			"\n\n++\n> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
		);
		expect(rendered).toContain("> > **(A)** a partnership;\n++\n\n");
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

		expect(rendered).toContain("~~legacy deleted block~~");
		expect(rendered).toContain(
			"++\n> **(5)** **QUALIFIED PASS-THROUGH ENTITY**",
		);
		expect(rendered).toContain("~~\n\n++");
	});

	it("emits parseable block delete delimiters", () => {
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

		expect(rendered).toContain("~~BLOCK_TEXT~~");
		expect(rendered).not.toContain("~~\nBLOCK_TEXT~~");
	});
});
