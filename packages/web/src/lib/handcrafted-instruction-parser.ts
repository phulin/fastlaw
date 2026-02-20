import { ParagraphRange } from "./types";

type GrammarNode =
	| { type: "literal"; value: string }
	| { type: "charClass"; value: string }
	| { type: "ref"; name: string }
	| { type: "sequence"; items: GrammarNode[] }
	| { type: "choice"; options: GrammarNode[] }
	| { type: "repeat"; mode: "*" | "+" | "?"; item: GrammarNode };

type GrammarRules = Map<string, GrammarNode>;

interface ExprToken {
	type: "literal" | "charClass" | "identifier" | "symbol";
	value: string;
}

interface ParseContext {
	input: string;
	rules: GrammarRules;
	cache: Map<string, number[]>;
	inFlight: Set<string>;
	nodeId: WeakMap<GrammarNode, number>;
	nextNodeId: number;
	nodeEndsCache: Map<string, number[]>;
}

interface BuildContext {
	parseContext: ParseContext;
	targetCache: Map<string, CstChild[] | null>;
	sequenceCache: Map<string, CstChild[] | null>;
}

type RuleName = string;

export enum GrammarAstNodeType {
	Instruction = "instruction",
	Parent = "parent",
	InitialLocator = "initial_locator",
	Underlying = "underlying",
	AmendedBy = "amended_by",
	AmendedBySpec = "amended_by_spec",
	AmendedBySource = "amended_by_source",
	AmendedBySection = "amended_by_section",
	Resolution = "resolution",
	ResolutionOrEdit = "resolution_or_edit",
	AmendmentSpec = "amendment_spec",
	TextLocation = "text_location",
	TextLocationAnchor = "text_location_anchor",
	Edits = "edits",
	Edit = "edit",
	Subinstructions = "subinstructions",
	Subinstruction = "subinstruction",
	SubHead = "sub_head",
	Subscope = "subscope",
	SubscopePlural = "subscope_plural",
	SubAmendedBy = "sub_amended_by",
	SubAmendedBySpec = "sub_amended_by_spec",
	SubAmendedContainer = "sub_amended_container",
	Act = "act",
	Codification = "codification",
	Ref = "ref",
	UscRef = "usc_ref",
	PubLawRef = "pub_law_ref",
	StatRef = "stat_ref",
	NewThings = "new_things",
	AfterBeforeTarget = "after_before_target",
	AfterBeforeSearch = "after_before_search",
	StrikingSpec = "striking_spec",
	StrikingTarget = "striking_target",
	StrikingSearch = "striking_search",
	Appearances = "appearances",
	StrikingLocation = "striking_location",
	FollowingSpec = "following_spec",
	ThroughSpec = "through_spec",
	InsertingSpec = "inserting_spec",
	InsertingSpace = "inserting_space",
	InnerLocation = "inner_location",
	SectionLocationOrSub = "section_location_or_sub",
	SectionOrSub = "section_or_sub",
	SectionId = "section_id",
	SubsectionOrSub = "subsection_or_sub",
	SubLocationOrSub = "sub_location_or_sub",
	SubLocationOrSubCaps = "sub_location_or_sub_caps",
	SubLocationList = "sub_location_list",
	SubLocationOrPlural = "sub_location_or_plural",
	SubLocation = "sub_location",
	SubLocationsPlural = "sub_locations_plural",
	SubName = "sub_name",
	SubNamePlural = "sub_name_plural",
	SubNameCaps = "sub_name_caps",
	SubId = "sub_id",
	LowerId = "lower_id",
	UpperId = "upper_id",
	DigitId = "digit_id",
	CommonlyKnown = "commonly_known",
	Ordinal = "ordinal",
	Block = "block",
	BlockLine = "block_line",
	Text = "text",
	Inline = "inline",
	Preceding = "preceding",
	Separator = "sep",
	Unknown = "unknown",
}

interface CstToken {
	kind: "token";
	start: number;
	end: number;
	text: string;
}

interface CstRule {
	kind: "rule";
	name: RuleName;
	start: number;
	end: number;
	children: CstChild[];
}

type CstChild = CstToken | CstRule;

export interface RuleAst<Name extends GrammarAstNodeType = GrammarAstNodeType> {
	type: Name;
	text: string;
	children: RuleAst[];
	tokens: string[];
	sourceLocation: ParagraphRange;
}

export interface ResolutionAst extends RuleAst<GrammarAstNodeType.Resolution> {
	amendmentSpec: RuleAst<GrammarAstNodeType.AmendmentSpec> | null;
	textLocation: RuleAst<GrammarAstNodeType.TextLocation> | null;
	edits: RuleAst<GrammarAstNodeType.Edits> | null;
	editList: RuleAst<GrammarAstNodeType.Edit>[];
}

export interface SubinstructionsAst
	extends RuleAst<GrammarAstNodeType.Subinstructions> {
	items: RuleAst<GrammarAstNodeType.Subinstruction>[];
}

export interface InstructionAst
	extends RuleAst<GrammarAstNodeType.Instruction> {
	parent: RuleAst<GrammarAstNodeType.Parent>;
	amendedBy: RuleAst<GrammarAstNodeType.AmendedBy> | null;
	resolution: ResolutionAst | null;
	subinstructions: SubinstructionsAst | null;
}

export interface ParsedInstruction {
	startIndex: number;
	endIndex: number;
	endColumn: number;
	text: string;
	parseOffset: number;
	ast: InstructionAst;
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

interface ParseCandidate {
	parseOffset: number;
	end: number;
}

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

	parseExpression(): GrammarNode {
		return this.parseChoice();
	}

	private parseChoice(): GrammarNode {
		const options: GrammarNode[] = [this.parseSequence()];
		while (this.peekSymbol("|")) {
			this.consumeSymbol("|");
			options.push(this.parseSequence());
		}
		return options.length === 1 ? options[0] : { type: "choice", options };
	}

	private parseSequence(): GrammarNode {
		const items: GrammarNode[] = [];
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

	private parseRepeat(): GrammarNode {
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

	private parsePrimary(): GrammarNode {
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

function parseExpressionToGrammarNode(expression: string): GrammarNode {
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
		astRules.set(name, parseExpressionToGrammarNode(expression));
	}

	const fallbackExpressions: Record<string, string> = {
		section_id: "[0-9]+ [A-Za-z0-9-]* | [0-9]+",
		subitem_or_sub: "subitem_id",
		sub_location_range: 'sub_location " through " sub_location',
	};
	for (const [name, expression] of Object.entries(fallbackExpressions)) {
		if (!astRules.has(name)) {
			astRules.set(name, parseExpressionToGrammarNode(expression));
		}
	}

	return astRules;
}

function uniqueSorted(values: Iterable<number>): number[] {
	return Array.from(new Set(values)).sort((a, b) => a - b);
}

function getNodeId(node: GrammarNode, ctx: ParseContext): number {
	const existing = ctx.nodeId.get(node);
	if (typeof existing === "number") return existing;
	const assigned = ctx.nextNodeId;
	ctx.nextNodeId += 1;
	ctx.nodeId.set(node, assigned);
	return assigned;
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

function parseNodeAll(
	node: GrammarNode,
	pos: number,
	ctx: ParseContext,
): number[] {
	const nodeKey = `${getNodeId(node, ctx)}@${pos}`;
	const cached = ctx.nodeEndsCache.get(nodeKey);
	if (cached) return cached;

	let results: number[] = [];
	if (node.type === "literal") {
		results = ctx.input.startsWith(node.value, pos)
			? [pos + node.value.length]
			: [];
	} else if (node.type === "charClass") {
		if (pos < ctx.input.length) {
			const re = new RegExp(`^[${node.value}]$`, "u");
			results = re.test(ctx.input[pos] ?? "") ? [pos + 1] : [];
		}
	} else if (node.type === "ref") {
		results = parseRuleAll(node.name, pos, ctx);
	} else if (node.type === "sequence") {
		let positions = [pos];
		for (const item of node.items) {
			const nextPositions = new Set<number>();
			for (const current of positions) {
				for (const end of parseNodeAll(item, current, ctx)) {
					nextPositions.add(end);
				}
			}
			positions = uniqueSorted(nextPositions);
			if (positions.length === 0) break;
		}
		results = positions;
	} else if (node.type === "choice") {
		const endings = new Set<number>();
		for (const option of node.options) {
			for (const end of parseNodeAll(option, pos, ctx)) {
				endings.add(end);
			}
		}
		results = uniqueSorted(endings);
	} else {
		if (node.mode === "?") {
			const endings = new Set<number>([pos]);
			for (const end of parseNodeAll(node.item, pos, ctx)) {
				endings.add(end);
			}
			results = uniqueSorted(endings);
		} else {
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
			results = uniqueSorted(seen);
		}
	}

	ctx.nodeEndsCache.set(nodeKey, results);
	return results;
}

function orderEndsForGreedy(ends: number[], node: GrammarNode): number[] {
	if (node.type === "ref" && node.name === "act") {
		return [...ends].sort((a, b) => a - b);
	}
	return [...ends].sort((a, b) => b - a);
}

function buildRuleToTarget(
	ruleName: string,
	pos: number,
	targetEnd: number,
	buildCtx: BuildContext,
): CstRule | null {
	const key = `rule:${ruleName}@${pos}->${targetEnd}`;
	if (buildCtx.targetCache.has(key)) {
		const cached = buildCtx.targetCache.get(key);
		if (!cached) return null;
		return {
			kind: "rule",
			name: ruleName,
			start: pos,
			end: targetEnd,
			children: cached,
		};
	}

	const rule = buildCtx.parseContext.rules.get(ruleName);
	if (!rule) throw new Error(`Unknown rule ${ruleName}`);
	const childNodes = buildNodeToTarget(rule, pos, targetEnd, buildCtx);
	buildCtx.targetCache.set(key, childNodes);
	if (!childNodes) return null;
	return {
		kind: "rule",
		name: ruleName,
		start: pos,
		end: targetEnd,
		children: childNodes,
	};
}

function buildNodeToTarget(
	node: GrammarNode,
	pos: number,
	targetEnd: number,
	buildCtx: BuildContext,
): CstChild[] | null {
	if (targetEnd < pos) return null;

	if (node.type === "literal") {
		if (targetEnd !== pos + node.value.length) return null;
		if (!buildCtx.parseContext.input.startsWith(node.value, pos)) return null;
		return [
			{
				kind: "token",
				start: pos,
				end: targetEnd,
				text: node.value,
			},
		];
	}

	if (node.type === "charClass") {
		if (targetEnd !== pos + 1) return null;
		if (pos >= buildCtx.parseContext.input.length) return null;
		const ch = buildCtx.parseContext.input[pos];
		if (!ch) return null;
		const re = new RegExp(`^[${node.value}]$`, "u");
		if (!re.test(ch)) return null;
		return [
			{
				kind: "token",
				start: pos,
				end: targetEnd,
				text: ch,
			},
		];
	}

	if (node.type === "ref") {
		const ruleNode = buildRuleToTarget(node.name, pos, targetEnd, buildCtx);
		if (!ruleNode) return null;
		return [ruleNode];
	}

	if (node.type === "choice") {
		const ranked = node.options
			.map((option, index) => {
				const ends = parseNodeAll(option, pos, buildCtx.parseContext);
				return {
					option,
					index,
					canReachTarget: ends.includes(targetEnd),
					bestEnd: ends.length > 0 ? ends[ends.length - 1] : -1,
				};
			})
			.filter((entry) => entry.canReachTarget)
			.sort((a, b) => {
				if (a.bestEnd !== b.bestEnd) return b.bestEnd - a.bestEnd;
				return a.index - b.index;
			});

		for (const entry of ranked) {
			const built = buildNodeToTarget(entry.option, pos, targetEnd, buildCtx);
			if (built) return built;
		}
		return null;
	}

	if (node.type === "sequence") {
		return buildSequenceToTarget(node.items, 0, pos, targetEnd, buildCtx);
	}

	if (node.mode === "?") {
		if (targetEnd === pos) return [];
		const builtItem = buildNodeToTarget(node.item, pos, targetEnd, buildCtx);
		if (!builtItem) return null;
		return builtItem;
	}

	if (node.mode === "*" && targetEnd === pos) {
		return [];
	}

	const firstEnds = parseNodeAll(node.item, pos, buildCtx.parseContext).filter(
		(end) => end > pos && end <= targetEnd,
	);
	const orderedFirstEnds = orderEndsForGreedy(firstEnds, node.item);

	for (const firstEnd of orderedFirstEnds) {
		const firstBuilt = buildNodeToTarget(node.item, pos, firstEnd, buildCtx);
		if (!firstBuilt) continue;
		if (firstEnd === targetEnd) {
			return [...firstBuilt];
		}
		const restBuilt = buildNodeToTarget(
			{ type: "repeat", mode: "*", item: node.item },
			firstEnd,
			targetEnd,
			buildCtx,
		);
		if (!restBuilt) continue;
		return [...firstBuilt, ...restBuilt];
	}

	return null;
}

function buildSequenceToTarget(
	items: GrammarNode[],
	itemIndex: number,
	pos: number,
	targetEnd: number,
	buildCtx: BuildContext,
): CstChild[] | null {
	const seqKey = `seq:${items.length}:${itemIndex}@${pos}->${targetEnd}`;
	if (buildCtx.sequenceCache.has(seqKey)) {
		return buildCtx.sequenceCache.get(seqKey) ?? null;
	}

	if (itemIndex === items.length) {
		const result = pos === targetEnd ? [] : null;
		buildCtx.sequenceCache.set(seqKey, result);
		return result;
	}

	const item = items[itemIndex];
	const rawEnds = parseNodeAll(item, pos, buildCtx.parseContext).filter(
		(end) => end <= targetEnd,
	);
	const orderedEnds = orderEndsForGreedy(rawEnds, item);

	for (const itemEnd of orderedEnds) {
		const itemBuilt = buildNodeToTarget(item, pos, itemEnd, buildCtx);
		if (!itemBuilt) continue;
		const restBuilt = buildSequenceToTarget(
			items,
			itemIndex + 1,
			itemEnd,
			targetEnd,
			buildCtx,
		);
		if (!restBuilt) continue;
		const result = [...itemBuilt, ...restBuilt];
		buildCtx.sequenceCache.set(seqKey, result);
		return result;
	}

	buildCtx.sequenceCache.set(seqKey, null);
	return null;
}

function toRuleAst(
	node: CstRule,
	input: string,
	resolveRange: (start: number, end: number) => ParagraphRange,
): RuleAst {
	const children: RuleAst[] = node.children
		.filter((child): child is CstRule => child.kind === "rule")
		.filter((child) => child.name !== "sep" && child.name !== "preceding")
		.map((child) => toRuleAst(child, input, resolveRange));
	const tokens = node.children
		.filter((child): child is CstToken => child.kind === "token")
		.map((child) => child.text);
	return {
		type: toNodeType(node.name),
		text: input.slice(node.start, node.end),
		children,
		tokens,
		sourceLocation: resolveRange(node.start, node.end),
	};
}

function toNodeType(name: string): GrammarAstNodeType {
	if (name === "by_edit") return GrammarAstNodeType.Edit;
	const values = Object.values(GrammarAstNodeType) as string[];
	if (values.includes(name)) return name as GrammarAstNodeType;
	return GrammarAstNodeType.Unknown;
}

function ruleChildrenByName<Name extends GrammarAstNodeType>(
	node: RuleAst,
	name: Name,
): RuleAst<Name>[] {
	return node.children.filter(
		(child): child is RuleAst<Name> => child.type === name,
	);
}

function firstRuleChildByName<Name extends GrammarAstNodeType>(
	node: RuleAst,
	name: Name,
): RuleAst<Name> | null {
	return ruleChildrenByName(node, name)[0] ?? null;
}

function buildResolutionAst(
	node: RuleAst<GrammarAstNodeType.Resolution>,
): ResolutionAst {
	const amendmentSpec = firstRuleChildByName(
		node,
		GrammarAstNodeType.AmendmentSpec,
	);
	const textLocation = firstRuleChildByName(
		node,
		GrammarAstNodeType.TextLocation,
	);
	const edits = firstRuleChildByName(node, GrammarAstNodeType.Edits);
	const editList = edits
		? ruleChildrenByName(edits, GrammarAstNodeType.Edit)
		: [];
	return {
		...node,
		amendmentSpec,
		textLocation,
		edits,
		editList,
	};
}

function collectSubinstructionNodes(
	node: RuleAst,
): RuleAst<GrammarAstNodeType.Subinstruction>[] {
	const direct = ruleChildrenByName(node, GrammarAstNodeType.Subinstruction);
	if (node.type === GrammarAstNodeType.Subinstructions) {
		return direct;
	}
	const nested: RuleAst<GrammarAstNodeType.Subinstruction>[] = [];
	for (const child of node.children) {
		nested.push(...collectSubinstructionNodes(child));
	}
	return nested;
}

function buildSubinstructionsAst(
	node: RuleAst<GrammarAstNodeType.Subinstructions>,
): SubinstructionsAst {
	return {
		...node,
		items: collectSubinstructionNodes(node),
	};
}

function buildInstructionAst(
	cst: CstRule,
	source: string,
	resolveRange: (start: number, end: number) => ParagraphRange,
): InstructionAst {
	const ruleAst = toRuleAst(
		cst,
		source,
		resolveRange,
	) as RuleAst<GrammarAstNodeType.Instruction>;
	const parent = firstRuleChildByName(ruleAst, GrammarAstNodeType.Parent);
	if (!parent) {
		throw new Error("Parsed instruction is missing required parent node.");
	}

	const resolutionNode = firstRuleChildByName(
		ruleAst,
		GrammarAstNodeType.Resolution,
	);
	const subinstructionsNode = firstRuleChildByName(
		ruleAst,
		GrammarAstNodeType.Subinstructions,
	);

	return {
		...ruleAst,
		parent,
		amendedBy: firstRuleChildByName(ruleAst, GrammarAstNodeType.AmendedBy),
		resolution: resolutionNode ? buildResolutionAst(resolutionNode) : null,
		subinstructions: subinstructionsNode
			? buildSubinstructionsAst(subinstructionsNode)
			: null,
	};
}

function pickBestCandidate(
	candidates: ParseCandidate[],
): ParseCandidate | null {
	if (candidates.length === 0) return null;
	return (
		candidates.sort((a, b) => {
			if (a.end !== b.end) return b.end - a.end;
			return a.parseOffset - b.parseOffset;
		})[0] ?? null
	);
}

function createParseContext(input: string, rules: GrammarRules): ParseContext {
	return {
		input,
		rules,
		cache: new Map(),
		inFlight: new Set(),
		nodeId: new WeakMap(),
		nextNodeId: 1,
		nodeEndsCache: new Map(),
	};
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
		resolveRange: (start: number, end: number) => ParagraphRange = () =>
			new ParagraphRange([], 0, 0),
	): ParsedInstruction | null {
		if (startIndex < 0 || startIndex >= lines.length) return null;
		const source = lines.slice(startIndex).join("\n");
		const candidates: ParseCandidate[] = [];

		for (const end of this.parsePrefix(source, "instruction")) {
			candidates.push({ parseOffset: 0, end });
		}

		const firstLine = lines[startIndex] ?? "";
		for (const anchorIndex of collectAnchorIndexes(firstLine)) {
			const anchoredSource = source.slice(anchorIndex);
			for (const anchoredEnd of this.parsePrefix(
				anchoredSource,
				"instruction",
			)) {
				candidates.push({
					parseOffset: anchorIndex,
					end: anchorIndex + anchoredEnd,
				});
			}
		}

		const best = pickBestCandidate(candidates);
		if (!best) return null;

		const parseInput = source.slice(best.parseOffset, best.end);
		const parseContext = createParseContext(parseInput, this.rules);
		const ruleNode = buildRuleToTarget("instruction", 0, parseInput.length, {
			parseContext,
			targetCache: new Map(),
			sequenceCache: new Map(),
		});
		if (!ruleNode) return null;
		const ast = buildInstructionAst(ruleNode, parseInput, (start, end) =>
			resolveRange(best.parseOffset + start, best.parseOffset + end),
		);

		const parsedText = source.slice(0, best.end);
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
			parseOffset: best.parseOffset,
			ast,
		};
	}

	parsePrefix(input: string, startRule = "instruction"): number[] {
		const ctx = createParseContext(input, this.rules);
		return parseRuleAll(startRule, 0, ctx);
	}
}

export function createHandcraftedInstructionParserFromSource(
	grammarSource: string,
): HandcraftedInstructionParser {
	return new HandcraftedInstructionParser(grammarSource);
}
