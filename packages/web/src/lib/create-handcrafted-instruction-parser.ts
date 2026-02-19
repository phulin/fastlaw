import amendmentGrammarSource from "../../amendment-grammar.bnf?raw";
import {
	GrammarAstNodeType,
	HandcraftedInstructionParser,
	type InstructionAst,
	type ParsedInstruction,
	type ResolutionAst,
	type RuleAst,
} from "./handcrafted-instruction-parser";

export {
	HandcraftedInstructionParser,
	GrammarAstNodeType,
	type InstructionAst,
	type ParsedInstruction,
	type ResolutionAst,
	type RuleAst,
};

export function createHandcraftedInstructionParser(): HandcraftedInstructionParser {
	return new HandcraftedInstructionParser(amendmentGrammarSource);
}
