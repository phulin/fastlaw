import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	GrammarAstNodeType,
	HandcraftedInstructionParser,
	type InstructionAst,
	type ParsedInstruction,
	type ResolutionAst,
	type RuleAst,
} from "../lib/handcrafted-instruction-parser";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_GRAMMAR_PATH = resolve(WEB_ROOT, "amendment-grammar.bnf");

export {
	HandcraftedInstructionParser,
	GrammarAstNodeType,
	type InstructionAst,
	type ParsedInstruction,
	type ResolutionAst,
	type RuleAst,
};

export function createHandcraftedInstructionParser(
	grammarPath: string = DEFAULT_GRAMMAR_PATH,
): HandcraftedInstructionParser {
	const grammarSource = readFileSync(grammarPath, "utf8");
	return new HandcraftedInstructionParser(grammarSource);
}
