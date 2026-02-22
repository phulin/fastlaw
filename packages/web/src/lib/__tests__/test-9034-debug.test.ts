import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { translateInstructionAstToEditTree } from "../amendment-ast-to-edit-tree";
import { applyEditTree } from "../amendment-edit-tree-apply";
import { createHandcraftedInstructionParser } from "../create-handcrafted-instruction-parser";

const fixtureDir = path.join(__dirname, "../__fixtures__");
const body = fs.readFileSync(
	path.join(fixtureDir, "usc-7-9034-full.md"),
	"utf-8",
);

// Use real Unicode chars: '' = U+2018 U+2019, " = U+201C, — = U+2014
const instructionText = `Section 1204 of the Agricultural Act of 2014 (7 U.S.C. 9034) is amended\u2014
(2) in subsection (c)\u2014
(A) by striking the period at the end and inserting \u2018\u2018; and\u2019\u2019;
(B) by striking \u2018\u2018at the loan rate\u2019\u2019 and inserting the following:
\u201cat a rate that is the lesser of\u2014
\u201c(1) the loan rate\u201d.`;

describe("9034 debug", () => {
	it("parses subsection c instruction", () => {
		const parser = createHandcraftedInstructionParser();
		const lines = instructionText.split("\n");
		const parsed = parser.parseInstructionFromLines(lines, 0, (start, end) => {
			const paragraphs = [];
			for (let i = start; i < end; i++) {
				paragraphs.push({
					text: lines[i] ?? "",
					index: i,
					startLine: i,
					endLine: i + 1,
					quoteDepth: 0,
					leadingLabels: [],
				});
			}
			return { paragraphs, startFirst: 0, endLast: lines[start]?.length ?? 0 };
		});

		console.log("Parsed?", !!parsed?.ast);
		expect(parsed?.ast).toBeTruthy();
		if (!parsed?.ast) return;

		const result = translateInstructionAstToEditTree(parsed.ast);

		function walkTree(node: any, depth = 0): void {
			const indent = "  ".repeat(depth);
			if (node.type === "edit") {
				const strike = node.edit.strike;
				const strikeTxt =
					strike?.kind === "text" ? strike.text.text : JSON.stringify(strike);
				const ins = node.edit.insert;
				const insTxt = ins?.text ?? JSON.stringify(ins);
				console.log(
					`${indent}EDIT: ${node.edit.kind}, strike="${strikeTxt}", insert="${insTxt}"`,
				);
			} else {
				const info = node.scope ?? node.restriction;
				console.log(`${indent}${node.type}: ${JSON.stringify(info)}`);
				for (const child of node.children ?? []) {
					walkTree(child, depth + 1);
				}
			}
		}
		for (const child of result.tree.children) {
			walkTree(child);
		}

		const effect = applyEditTree({
			tree: result.tree,
			sectionPath: "/statutes/usc/section/7/9034",
			sectionBody: body,
		});

		console.log("\nEffect status:", effect.status);
		console.log("Apply summary:", JSON.stringify(effect.applySummary, null, 2));

		expect(effect.applySummary.failedItems.length).toBe(0);
	});
});
