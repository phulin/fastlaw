import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type AstNode =
	| { type: "literal"; value: string }
	| { type: "charClass"; value: string }
	| { type: "ref"; name: string }
	| { type: "sequence"; items: AstNode[] }
	| { type: "choice"; options: AstNode[] }
	| { type: "repeat"; mode: "*" | "+" | "?"; item: AstNode };

type GrammarRules = Map<string, AstNode>;

interface ExprToken {
	type: "literal" | "charClass" | "identifier" | "symbol";
	value: string;
}

interface ParseContext {
	input: string;
	rules: GrammarRules;
	cache: Map<string, number[]>;
	inFlight: Set<string>;
}

export interface ParsedInstruction {
	startIndex: number;
	endIndex: number;
	endColumn: number;
	text: string;
}

const ANCHORED_START_MARKERS = [
	"Section ",
	"Subsection ",
	"Paragraph ",
	"Subparagraph ",
	"Clause ",
	"Subclause ",
	"Item ",
	"Subitem ",
] as const;

function collectAnchorIndexes(line: string): number[] {
	const indexes = new Set<number>();
	for (const marker of ANCHORED_START_MARKERS) {
		const idx = line.indexOf(marker);
		if (idx !== -1) indexes.add(idx);
	}
	return Array.from(indexes).sort((a, b) => a - b);
}

class ExpressionTokenizer {
	private readonly source: string;
	private index = 0;

	constructor(source: string) {
		this.source = source;
	}

	next(): ExprToken | null {
		this.skipWhitespace();
		if (this.index >= this.source.length) return null;

		const current = this.source[this.index];
		if (
			current === "|" ||
			current === "(" ||
			current === ")" ||
			current === "*" ||
			current === "+" ||
			current === "?"
		) {
			this.index += 1;
			return { type: "symbol", value: current };
		}

		if (current === '"') {
			return { type: "literal", value: this.readLiteral() };
		}

		if (current === "[") {
			return { type: "charClass", value: this.readCharClass() };
		}

		const identifier = this.readIdentifier();
		if (identifier) return { type: "identifier", value: identifier };

		throw new Error(
			`Unexpected token near: ${this.source.slice(this.index, this.index + 30)}`,
		);
	}

	private skipWhitespace(): void {
		while (
			this.index < this.source.length &&
			/\s/.test(this.source[this.index] ?? "")
		) {
			this.index += 1;
		}
	}

	private readLiteral(): string {
		let value = "";
		this.index += 1;
		while (this.index < this.source.length) {
			const ch = this.source[this.index];
			if (!ch) break;
			if (ch === "\\") {
				const next = this.source[this.index + 1];
				if (next === "n") {
					value += "\n";
					this.index += 2;
					continue;
				}
				if (next === '"' || next === "\\" || next === "t") {
					value += next === "t" ? "\t" : next;
					this.index += 2;
					continue;
				}
				value += next ?? "";
				this.index += 2;
				continue;
			}
			if (ch === '"') {
				this.index += 1;
				return value;
			}
			value += ch;
			this.index += 1;
		}
		throw new Error("Unterminated literal.");
	}

	private readCharClass(): string {
		let value = "";
		this.index += 1;
		while (this.index < this.source.length) {
			const ch = this.source[this.index];
			if (!ch) break;
			if (ch === "]") {
				this.index += 1;
				return value;
			}
			value += ch;
			this.index += 1;
		}
		throw new Error("Unterminated character class.");
	}

	private readIdentifier(): string | null {
		const rest = this.source.slice(this.index);
		const match = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
		if (!match) return null;
		this.index += match[0].length;
		return match[0];
	}
}

class ExpressionParser {
	private readonly tokens: ExprToken[];
	private index = 0;

	constructor(tokens: ExprToken[]) {
		this.tokens = tokens;
	}

	parseExpression(): AstNode {
		return this.parseChoice();
	}

	private parseChoice(): AstNode {
		const options: AstNode[] = [this.parseSequence()];
		while (this.peekSymbol("|")) {
			this.consumeSymbol("|");
			options.push(this.parseSequence());
		}
		return options.length === 1 ? options[0] : { type: "choice", options };
	}

	private parseSequence(): AstNode {
		const items: AstNode[] = [];
		while (true) {
			const token = this.peek();
			if (
				!token ||
				(token.type === "symbol" &&
					(token.value === "|" || token.value === ")"))
			) {
				break;
			}
			items.push(this.parseRepeat());
		}
		if (items.length === 0) {
			throw new Error("Empty sequences are unsupported.");
		}
		return items.length === 1 ? items[0] : { type: "sequence", items };
	}

	private parseRepeat(): AstNode {
		let node = this.parsePrimary();
		const token = this.peek();
		if (
			token?.type === "symbol" &&
			(token.value === "*" || token.value === "+" || token.value === "?")
		) {
			this.index += 1;
			node = { type: "repeat", mode: token.value, item: node };
		}
		return node;
	}

	private parsePrimary(): AstNode {
		const token = this.peek();
		if (!token) throw new Error("Unexpected end of expression.");

		if (token.type === "literal") {
			this.index += 1;
			return { type: "literal", value: token.value };
		}
		if (token.type === "charClass") {
			this.index += 1;
			return { type: "charClass", value: token.value };
		}
		if (token.type === "identifier") {
			this.index += 1;
			return { type: "ref", name: token.value };
		}
		if (token.type === "symbol" && token.value === "(") {
			this.index += 1;
			const expr = this.parseChoice();
			this.consumeSymbol(")");
			return expr;
		}
		throw new Error(`Unexpected token ${token.type}:${token.value}`);
	}

	private peek(): ExprToken | null {
		return this.tokens[this.index] ?? null;
	}

	private peekSymbol(value: string): boolean {
		const token = this.peek();
		return token?.type === "symbol" && token.value === value;
	}

	private consumeSymbol(value: string): void {
		if (!this.peekSymbol(value)) throw new Error(`Expected symbol ${value}`);
		this.index += 1;
	}
}

function parseExpressionToAst(expression: string): AstNode {
	const tokenizer = new ExpressionTokenizer(expression);
	const tokens: ExprToken[] = [];
	while (true) {
		const token = tokenizer.next();
		if (!token) break;
		tokens.push(token);
	}
	return new ExpressionParser(tokens).parseExpression();
}

function parseRules(grammarSource: string): GrammarRules {
	const rules = new Map<string, string>();
	let currentRule: string | null = null;
	for (const line of grammarSource.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const definitionIndex = line.indexOf("::=");
		if (definitionIndex >= 0) {
			const ruleName = line.slice(0, definitionIndex).trim();
			const expression = line.slice(definitionIndex + 3).trim();
			rules.set(ruleName, expression);
			currentRule = ruleName;
			continue;
		}
		if (!currentRule) {
			throw new Error(
				`Continuation encountered before rule declaration: ${line}`,
			);
		}
		const prev = rules.get(currentRule);
		if (!prev) throw new Error(`Missing expression buffer for ${currentRule}`);
		rules.set(currentRule, `${prev} ${trimmed}`);
	}

	const astRules: GrammarRules = new Map();
	for (const [name, expression] of rules) {
		astRules.set(name, parseExpressionToAst(expression));
	}

	const fallbackExpressions: Record<string, string> = {
		section_id: "[0-9]+ [A-Za-z0-9-]* | [0-9]+",
		subitem_or_sub: "subitem_id",
		sub_location_range: 'sub_location " through " sub_location',
	};
	for (const [name, expression] of Object.entries(fallbackExpressions)) {
		if (!astRules.has(name)) {
			astRules.set(name, parseExpressionToAst(expression));
		}
	}

	return astRules;
}

function uniqueSorted(values: Iterable<number>): number[] {
	return Array.from(new Set(values)).sort((a, b) => a - b);
}

function parseRuleAll(name: string, pos: number, ctx: ParseContext): number[] {
	const cacheKey = `${name}@${pos}`;
	const cached = ctx.cache.get(cacheKey);
	if (cached) return cached;
	if (ctx.inFlight.has(cacheKey)) return [];
	ctx.inFlight.add(cacheKey);

	const node = ctx.rules.get(name);
	if (!node) throw new Error(`Unknown rule ${name}`);
	const results = parseNodeAll(node, pos, ctx);
	ctx.cache.set(cacheKey, results);
	ctx.inFlight.delete(cacheKey);
	return results;
}

function parseNodeAll(node: AstNode, pos: number, ctx: ParseContext): number[] {
	if (node.type === "literal") {
		return ctx.input.startsWith(node.value, pos)
			? [pos + node.value.length]
			: [];
	}

	if (node.type === "charClass") {
		if (pos >= ctx.input.length) return [];
		const re = new RegExp(`^[${node.value}]$`, "u");
		return re.test(ctx.input[pos] ?? "") ? [pos + 1] : [];
	}

	if (node.type === "ref") {
		return parseRuleAll(node.name, pos, ctx);
	}

	if (node.type === "sequence") {
		let positions = [pos];
		for (const item of node.items) {
			const nextPositions = new Set<number>();
			for (const current of positions) {
				for (const end of parseNodeAll(item, current, ctx)) {
					nextPositions.add(end);
				}
			}
			positions = uniqueSorted(nextPositions);
			if (positions.length === 0) return [];
		}
		return positions;
	}

	if (node.type === "choice") {
		const endings = new Set<number>();
		for (const option of node.options) {
			for (const end of parseNodeAll(option, pos, ctx)) {
				endings.add(end);
			}
		}
		return uniqueSorted(endings);
	}

	if (node.type === "repeat") {
		if (node.mode === "?") {
			const endings = new Set<number>([pos]);
			for (const end of parseNodeAll(node.item, pos, ctx)) {
				endings.add(end);
			}
			return uniqueSorted(endings);
		}

		const seen = new Set<number>([pos]);
		const queue: number[] = [pos];
		while (queue.length > 0) {
			const current = queue.shift();
			if (typeof current !== "number") break;
			for (const end of parseNodeAll(node.item, current, ctx)) {
				if (end === current || seen.has(end)) continue;
				seen.add(end);
				queue.push(end);
			}
		}
		if (node.mode === "+") seen.delete(pos);
		return uniqueSorted(seen);
	}

	return [];
}

export class HandcraftedInstructionParser {
	private readonly rules: GrammarRules;

	constructor(grammarSource: string) {
		this.rules = parseRules(grammarSource);
		if (!this.rules.has("instruction")) {
			throw new Error("Grammar must define instruction.");
		}
	}

	parseInstructionFromLines(
		lines: readonly string[],
		startIndex: number,
	): ParsedInstruction | null {
		if (startIndex < 0 || startIndex >= lines.length) return null;
		const source = lines.slice(startIndex).join("\n");
		const candidateEnds = new Set<number>(
			this.parsePrefix(source, "instruction"),
		);
		const firstLine = lines[startIndex] ?? "";
		for (const anchorIndex of collectAnchorIndexes(firstLine)) {
			const anchoredSource = source.slice(anchorIndex);
			for (const anchoredEnd of this.parsePrefix(
				anchoredSource,
				"instruction",
			)) {
				candidateEnds.add(anchorIndex + anchoredEnd);
			}
		}
		const ends = uniqueSorted(candidateEnds);
		if (ends.length === 0) return null;

		const bestEnd = ends.at(-1);
		if (typeof bestEnd !== "number") return null;
		const parsedText = source.slice(0, bestEnd);
		const newlineCount = (parsedText.match(/\n/g) ?? []).length;
		const endIndex = startIndex + newlineCount;
		const lastLineBreak = parsedText.lastIndexOf("\n");
		const endColumn =
			lastLineBreak === -1
				? parsedText.length
				: parsedText.length - lastLineBreak - 1;

		return {
			startIndex,
			endIndex,
			endColumn,
			text: parsedText,
		};
	}

	parsePrefix(input: string, startRule = "instruction"): number[] {
		const ctx: ParseContext = {
			input,
			rules: this.rules,
			cache: new Map(),
			inFlight: new Set(),
		};
		return parseRuleAll(startRule, 0, ctx);
	}
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_GRAMMAR_PATH = resolve(WEB_ROOT, "amendment-grammar.bnf");

export function createHandcraftedInstructionParser(
	grammarPath: string = DEFAULT_GRAMMAR_PATH,
): HandcraftedInstructionParser {
	const grammarSource = readFileSync(grammarPath, "utf8");
	return new HandcraftedInstructionParser(grammarSource);
}
