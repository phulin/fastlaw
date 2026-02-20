import { translateInstructionAstToEditTree } from "./packages/web/src/lib/amendment-ast-to-edit-tree.ts";
import { createHandcraftedInstructionParser } from "./packages/web/src/lib/create-handcrafted-instruction-parser.ts";

const parser = createHandcraftedInstructionParser();
const parsed = parser.parseInstructionFromLines(
	[
		"Section 101 of title 10, United States Code, is amended in the first sentence of subsection (a) by striking “A”.",
	],
	0,
);
const result = translateInstructionAstToEditTree(parsed.ast);
console.log(JSON.stringify(result.tree.children, null, 2));
