import { ParagraphRange } from "../../types";

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
	nodeIds: WeakMap<GrammarNode, number>;
	cache: Map<string, Map<number, number[]>>;
	inFlight: Map<string, Set<number>>;
	nodeEndsCache: Map<number, Map<number, number[]>>;
	charClassRegexCache: Map<string, RegExp>;
}

interface BuildContext {
	parseContext: ParseContext;
	targetCache: Map<string, Map<number, Map<number, CstChild[] | null>>>;
	sequenceCache: WeakMap<
		GrammarNode[],
		Map<number, Map<number, Map<number, CstChild[] | null>>>
	>;
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
const FAST_REJECT_SCAN_WINDOW = 700;

interface ParseCandidate {
	parseOffset: number;
	end: number;
}

interface ParseInstructionOptions {
	allowAnchoredOffsets?: boolean;
	useFastReject?: boolean;
}

function collectAnchorIndexes(line: string): number[] {
	const indexes = new Set<number>();
	for (const marker of ANCHORED_START_MARKERS) {
		const idx = line.indexOf(marker);
		if (idx !== -1) indexes.add(idx);
	}
	return Array.from(indexes).sort((a, b) => a - b);
}

function couldBeInstructionStart(source: string, startOffset: number): boolean {
	const firstNewline = source.indexOf("\n", startOffset);
	const windowEnd = Math.min(
		source.length,
		startOffset + FAST_REJECT_SCAN_WINDOW,
		firstNewline === -1
			? source.length
			: firstNewline + FAST_REJECT_SCAN_WINDOW,
	);
	const amendedIndex = source.indexOf("amended", startOffset);
	return amendedIndex !== -1 && amendedIndex < windowEnd;
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

function unique(values: Iterable<number>): number[] {
	if (values instanceof Set) return Array.from(values);
	return Array.from(new Set(values));
}

function maxEnd(ends: readonly number[]): number {
	let max = -1;
	for (const end of ends) {
		if (end > max) max = end;
	}
	return max;
}

function getNodeId(node: GrammarNode, ctx: ParseContext): number {
	const existing = ctx.nodeIds.get(node);
	if (typeof existing === "number") return existing;
	throw new Error("Grammar node id missing.");
}

function parseRuleAll(name: string, pos: number, ctx: ParseContext): number[] {
	const ruleCache = ctx.cache.get(name);
	if (ruleCache?.has(pos)) {
		return ruleCache.get(pos) ?? [];
	}

	let inFlightForRule = ctx.inFlight.get(name);
	if (!inFlightForRule) {
		inFlightForRule = new Set<number>();
		ctx.inFlight.set(name, inFlightForRule);
	}
	if (inFlightForRule.has(pos)) return [];
	inFlightForRule.add(pos);

	const node = ctx.rules.get(name);
	if (!node) throw new Error(`Unknown rule ${name}`);
	const results = parseNodeAll(node, pos, ctx);
	if (!ruleCache) {
		ctx.cache.set(name, new Map([[pos, results]]));
	} else {
		ruleCache.set(pos, results);
	}
	inFlightForRule.delete(pos);
	if (inFlightForRule.size === 0) {
		ctx.inFlight.delete(name);
	}
	return results;
}

function parseNodeAll(
	node: GrammarNode,
	pos: number,
	ctx: ParseContext,
): number[] {
	const nodeId = getNodeId(node, ctx);
	const nodeCache = ctx.nodeEndsCache.get(nodeId);
	if (nodeCache?.has(pos)) {
		return nodeCache.get(pos) ?? [];
	}

	let results: number[] = [];
	if (node.type === "literal") {
		results = ctx.input.startsWith(node.value, pos)
			? [pos + node.value.length]
			: [];
	} else if (node.type === "charClass") {
		if (pos < ctx.input.length) {
			const re = getCharClassRegex(node.value, ctx);
			results = re.test(ctx.input[pos] ?? "") ? [pos + 1] : [];
		}
	} else if (node.type === "ref") {
		results = parseRuleAll(node.name, pos, ctx);
	} else if (node.type === "sequence") {
		let positions = [pos];
		for (const item of node.items) {
			if (positions.length === 1) {
				const only = positions[0];
				if (typeof only !== "number") {
					positions = [];
					break;
				}
				positions = parseNodeAll(item, only, ctx);
			} else {
				const nextPositions = new Set<number>();
				for (const current of positions) {
					for (const end of parseNodeAll(item, current, ctx)) {
						nextPositions.add(end);
					}
				}
				positions = unique(nextPositions);
			}
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
		results = unique(endings);
	} else {
		if (node.mode === "?") {
			const endings = new Set<number>([pos]);
			for (const end of parseNodeAll(node.item, pos, ctx)) {
				endings.add(end);
			}
			results = unique(endings);
		} else {
			const seen = new Set<number>([pos]);
			const queue: number[] = [pos];
			for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
				const current = queue[queueIndex];
				if (typeof current !== "number") continue;
				for (const end of parseNodeAll(node.item, current, ctx)) {
					if (end === current || seen.has(end)) continue;
					seen.add(end);
					queue.push(end);
				}
			}
			if (node.mode === "+") seen.delete(pos);
			results = unique(seen);
		}
	}

	if (!nodeCache) {
		ctx.nodeEndsCache.set(nodeId, new Map([[pos, results]]));
	} else {
		nodeCache.set(pos, results);
	}
	return results;
}

function orderEndsForGreedy(ends: number[], node: GrammarNode): number[] {
	if (ends.length <= 1) return ends;
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
	const cached = getCachedRuleTarget(buildCtx, ruleName, pos, targetEnd);
	if (cached !== undefined) {
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
	setCachedRuleTarget(buildCtx, ruleName, pos, targetEnd, childNodes);
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
		const re = getCharClassRegex(node.value, buildCtx.parseContext);
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
		const candidates: {
			option: GrammarNode;
			index: number;
			bestEnd: number;
		}[] = [];
		for (let index = 0; index < node.options.length; index += 1) {
			const option = node.options[index];
			if (!option) continue;
			const ends = parseNodeAll(option, pos, buildCtx.parseContext);
			if (!ends.includes(targetEnd)) continue;
			candidates.push({ option, index, bestEnd: maxEnd(ends) });
		}

		while (candidates.length > 0) {
			let bestCandidateIndex = 0;
			for (let i = 1; i < candidates.length; i += 1) {
				const candidate = candidates[i];
				const best = candidates[bestCandidateIndex];
				if (!candidate || !best) continue;
				if (
					candidate.bestEnd > best.bestEnd ||
					(candidate.bestEnd === best.bestEnd && candidate.index < best.index)
				) {
					bestCandidateIndex = i;
				}
			}
			const [entry] = candidates.splice(bestCandidateIndex, 1);
			if (!entry) break;
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
	const cached = getCachedSequence(buildCtx, items, itemIndex, pos, targetEnd);
	if (cached !== undefined) {
		return cached ?? null;
	}

	if (itemIndex === items.length) {
		const result = pos === targetEnd ? [] : null;
		setCachedSequence(buildCtx, items, itemIndex, pos, targetEnd, result);
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
		setCachedSequence(buildCtx, items, itemIndex, pos, targetEnd, result);
		return result;
	}

	setCachedSequence(buildCtx, items, itemIndex, pos, targetEnd, null);
	return null;
}

function getCachedRuleTarget(
	buildCtx: BuildContext,
	ruleName: string,
	pos: number,
	targetEnd: number,
): CstChild[] | null | undefined {
	return buildCtx.targetCache.get(ruleName)?.get(pos)?.get(targetEnd);
}

function setCachedRuleTarget(
	buildCtx: BuildContext,
	ruleName: string,
	pos: number,
	targetEnd: number,
	value: CstChild[] | null,
): void {
	let byRule = buildCtx.targetCache.get(ruleName);
	if (!byRule) {
		byRule = new Map();
		buildCtx.targetCache.set(ruleName, byRule);
	}
	let byPos = byRule.get(pos);
	if (!byPos) {
		byPos = new Map();
		byRule.set(pos, byPos);
	}
	byPos.set(targetEnd, value);
}

function getCachedSequence(
	buildCtx: BuildContext,
	items: GrammarNode[],
	itemIndex: number,
	pos: number,
	targetEnd: number,
): CstChild[] | null | undefined {
	return buildCtx.sequenceCache
		.get(items)
		?.get(itemIndex)
		?.get(pos)
		?.get(targetEnd);
}

function setCachedSequence(
	buildCtx: BuildContext,
	items: GrammarNode[],
	itemIndex: number,
	pos: number,
	targetEnd: number,
	value: CstChild[] | null,
): void {
	let byItems = buildCtx.sequenceCache.get(items);
	if (!byItems) {
		byItems = new Map();
		buildCtx.sequenceCache.set(items, byItems);
	}
	let byIndex = byItems.get(itemIndex);
	if (!byIndex) {
		byIndex = new Map();
		byItems.set(itemIndex, byIndex);
	}
	let byPos = byIndex.get(pos);
	if (!byPos) {
		byPos = new Map();
		byIndex.set(pos, byPos);
	}
	byPos.set(targetEnd, value);
}

function toRuleAst(
	node: CstRule,
	input: string,
	resolveRange: (start: number, end: number) => ParagraphRange,
): RuleAst {
	const children: RuleAst[] = [];
	const tokens: string[] = [];
	for (const child of node.children) {
		if (child.kind === "token") {
			tokens.push(child.text);
			continue;
		}
		if (child.name === "sep" || child.name === "preceding") {
			continue;
		}
		children.push(toRuleAst(child, input, resolveRange));
	}
	return {
		type: toNodeType(node.name),
		text: input.slice(node.start, node.end),
		children,
		tokens,
		sourceLocation: resolveRange(node.start, node.end),
	};
}

const KNOWN_NODE_TYPES = new Set<string>(
	Object.values(GrammarAstNodeType) as string[],
);

function toNodeType(name: string): GrammarAstNodeType {
	if (name === "by_edit") return GrammarAstNodeType.Edit;
	if (KNOWN_NODE_TYPES.has(name)) return name as GrammarAstNodeType;
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

function assignGrammarNodeIds(
	rules: GrammarRules,
): WeakMap<GrammarNode, number> {
	const nodeIds = new WeakMap<GrammarNode, number>();
	let nextNodeId = 1;

	const visit = (node: GrammarNode): void => {
		if (nodeIds.has(node)) return;
		nodeIds.set(node, nextNodeId);
		nextNodeId += 1;

		if (node.type === "sequence") {
			for (const item of node.items) visit(item);
			return;
		}
		if (node.type === "choice") {
			for (const option of node.options) visit(option);
			return;
		}
		if (node.type === "repeat") {
			visit(node.item);
		}
	};

	for (const node of rules.values()) {
		visit(node);
	}

	return nodeIds;
}

function createParseContext(
	input: string,
	rules: GrammarRules,
	nodeIds: WeakMap<GrammarNode, number>,
): ParseContext {
	return {
		input,
		rules,
		nodeIds,
		cache: new Map(),
		inFlight: new Map(),
		nodeEndsCache: new Map(),
		charClassRegexCache: new Map(),
	};
}

function getCharClassRegex(charClass: string, ctx: ParseContext): RegExp {
	const cached = ctx.charClassRegexCache.get(charClass);
	if (cached) return cached;
	const compiled = new RegExp(`^[${charClass}]$`, "u");
	ctx.charClassRegexCache.set(charClass, compiled);
	return compiled;
}

export class HandcraftedInstructionParser {
	private readonly rules: GrammarRules;
	private readonly nodeIds: WeakMap<GrammarNode, number>;

	constructor(grammarSource: string) {
		this.rules = parseRules(grammarSource);
		if (!this.rules.has("instruction")) {
			throw new Error("Grammar must define instruction.");
		}
		this.nodeIds = assignGrammarNodeIds(this.rules);
	}

	parseInstructionFromLines(
		lines: readonly string[],
		startIndex: number,
		resolveRange: (start: number, end: number) => ParagraphRange = () =>
			new ParagraphRange([], 0, 0),
		options: ParseInstructionOptions = {},
	): ParsedInstruction | null {
		if (startIndex < 0 || startIndex >= lines.length) return null;
		const source = lines.slice(startIndex).join("\n");
		const parsed = this.parseInstructionFromSource(
			source,
			0,
			resolveRange,
			options,
		);
		if (!parsed) return null;
		const parsedText = parsed.text;
		const newlineCount = (parsedText.match(/\n/g) ?? []).length;
		const endIndex = startIndex + newlineCount;
		const lastLineBreak = parsedText.lastIndexOf("\n");
		const endColumn =
			lastLineBreak === -1
				? parsedText.length
				: parsedText.length - lastLineBreak - 1;

		return {
			...parsed,
			startIndex,
			endIndex,
			endColumn,
		};
	}

	parseInstructionFromSource(
		source: string,
		startOffset: number,
		resolveRange: (start: number, end: number) => ParagraphRange = () =>
			new ParagraphRange([], 0, 0),
		options: ParseInstructionOptions = {},
	): ParsedInstruction | null {
		if (startOffset < 0 || startOffset >= source.length) return null;
		const useFastReject = options.useFastReject ?? true;
		if (useFastReject && !couldBeInstructionStart(source, startOffset)) {
			return null;
		}
		const parseContext = createParseContext(source, this.rules, this.nodeIds);
		let best: ParseCandidate | null = null;
		const initialEnd = maxEnd(
			parseRuleAll("instruction", startOffset, parseContext),
		);
		if (initialEnd >= 0) {
			best = { parseOffset: startOffset, end: initialEnd };
		}

		const allowAnchoredOffsets = options.allowAnchoredOffsets ?? true;
		if (allowAnchoredOffsets) {
			const lineEnd = source.indexOf("\n", startOffset);
			const firstLine =
				lineEnd === -1
					? source.slice(startOffset)
					: source.slice(startOffset, lineEnd);
			for (const anchorIndex of collectAnchorIndexes(firstLine)) {
				const anchoredStart = startOffset + anchorIndex;
				const anchoredEnd = maxEnd(
					parseRuleAll("instruction", anchoredStart, parseContext),
				);
				if (anchoredEnd >= 0) {
					const candidate: ParseCandidate = {
						parseOffset: anchoredStart,
						end: anchoredEnd,
					};
					if (
						!best ||
						candidate.end > best.end ||
						(candidate.end === best.end &&
							candidate.parseOffset < best.parseOffset)
					) {
						best = candidate;
					}
				}
			}
		}

		if (!best) return null;

		const ruleNode = buildRuleToTarget(
			"instruction",
			best.parseOffset,
			best.end,
			{
				parseContext,
				targetCache: new Map(),
				sequenceCache: new WeakMap(),
			},
		);
		if (!ruleNode) return null;
		const ast = buildInstructionAst(ruleNode, source, (start, end) =>
			resolveRange(start - startOffset, end - startOffset),
		);

		return {
			startIndex: 0,
			endIndex: 0,
			endColumn: 0,
			text: source.slice(startOffset, best.end),
			parseOffset: best.parseOffset - startOffset,
			ast,
		};
	}

	parsePrefix(input: string, startRule = "instruction"): number[] {
		const ctx = createParseContext(input, this.rules, this.nodeIds);
		return parseRuleAll(startRule, 0, ctx);
	}

	parsePrefixFromOffset(
		input: string,
		startOffset: number,
		startRule = "instruction",
	): number[] {
		const ctx = createParseContext(input, this.rules, this.nodeIds);
		return parseRuleAll(startRule, startOffset, ctx);
	}
}

export function createHandcraftedInstructionParserFromSource(
	grammarSource: string,
): HandcraftedInstructionParser {
	return new HandcraftedInstructionParser(grammarSource);
}
