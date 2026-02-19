import {
	type EditNode,
	type EditTarget,
	type InnerLocationTarget,
	InnerLocationTargetKind,
	type InstructionSemanticTree,
	type LocationRestriction,
	LocationRestrictionKind,
	type LocationRestrictionNode,
	PunctuationKind,
	ScopeKind,
	type ScopeNode,
	type ScopeSelector,
	SearchTargetKind,
	SemanticNodeType,
	type StructuralReference,
	type TargetScopeSegment,
	TextLocationAnchorKind,
	type UltimateEdit,
	UltimateEditKind,
} from "./amendment-edit-tree";
import {
	GrammarAstNodeType,
	type InstructionAst,
	type ResolutionAst,
	type RuleAst,
} from "./handcrafted-instruction-parser";

type TreeChild = ScopeNode | LocationRestrictionNode | EditNode;

type WrapperSpec =
	| { type: "scope"; scope: ScopeSelector }
	| { type: "restriction"; restriction: LocationRestriction };

interface TranslationContext {
	issues: TranslationIssue[];
	scopePath: ScopeSelector[];
	moveFromRefs: StructuralReference[] | null;
}

export interface TranslationIssue {
	message: string;
	nodeType?: GrammarAstNodeType;
	sourceText?: string;
}

export interface TranslationResult {
	tree: InstructionSemanticTree;
	issues: TranslationIssue[];
}

const SCOPE_ORDER: ScopeKind[] = [
	ScopeKind.Section,
	ScopeKind.Subsection,
	ScopeKind.Paragraph,
	ScopeKind.Subparagraph,
	ScopeKind.Clause,
	ScopeKind.Subclause,
	ScopeKind.Item,
	ScopeKind.Subitem,
];

const ORDINAL_TO_NUMBER: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	sixth: 6,
	seventh: 7,
	eighth: 8,
	ninth: 9,
	tenth: 10,
};

const USC_TITLE_REFERENCE_RE = /^(\d+)\s+(?:U\.S\.C\.|USC)(?:\s|$)/i;
const USC_TITLE_UNDERLYING_RE = /title\s+(\d+),\s+United States Code/i;
const INTERNAL_REVENUE_CODE_RE = /\bInternal Revenue Code of 1986\b/i;

export function translateInstructionAstToEditTree(
	ast: InstructionAst,
): TranslationResult {
	const issues: TranslationIssue[] = [];
	const baseContext: TranslationContext = {
		issues,
		scopePath: [],
		moveFromRefs: null,
	};
	const children: TreeChild[] = [];

	if (ast.resolution) {
		children.push(...translateResolution(ast.resolution, baseContext, []));
	}
	if (ast.subinstructions) {
		for (const item of ast.subinstructions.items) {
			children.push(...translateSubinstruction(item, baseContext, []));
		}
	}

	const targetScopePath = extractTargetScopePath(ast.parent, issues);

	return {
		tree: {
			type: SemanticNodeType.InstructionRoot,
			targetScopePath,
			targetSection: extractTargetSection(targetScopePath),
			children,
		},
		issues,
	};
}

function translateSubinstruction(
	node: RuleAst<GrammarAstNodeType.Subinstruction>,
	context: TranslationContext,
	inheritedWrappers: WrapperSpec[],
): TreeChild[] {
	const subHead = findChild(node, GrammarAstNodeType.SubHead);
	const localWrappers: WrapperSpec[] = [];
	let localContext = context;

	if (subHead) {
		const scoped = parseSubscopeWrappers(subHead, localContext);
		localWrappers.push(...scoped.wrappers);
		localContext = scoped.context;

		const textLocationNode = findChild(
			subHead,
			GrammarAstNodeType.TextLocation,
		);
		if (textLocationNode) {
			const restriction = parseTextLocation(textLocationNode, localContext);
			if (restriction) {
				localWrappers.push({ type: "restriction", restriction });
				if (restriction.kind === LocationRestrictionKind.In) {
					localContext = {
						...localContext,
						moveFromRefs: restriction.refs,
					};
				}
			}
		}
	}

	const wrappers = [...inheritedWrappers, ...localWrappers];
	const nestedSubinstructions = findChild(
		node,
		GrammarAstNodeType.Subinstructions,
	);
	if (nestedSubinstructions) {
		const nestedChildren: TreeChild[] = [];
		for (const item of findChildren(
			nestedSubinstructions,
			GrammarAstNodeType.Subinstruction,
		)) {
			nestedChildren.push(
				...translateSubinstruction(item, localContext, wrappers),
			);
		}
		return nestedChildren;
	}

	const resolutionOrEdit = findChild(node, GrammarAstNodeType.ResolutionOrEdit);
	if (resolutionOrEdit) {
		const resolution = findChild(
			resolutionOrEdit,
			GrammarAstNodeType.Resolution,
		);
		if (resolution) {
			return translateResolution(
				toResolutionAst(resolution),
				localContext,
				wrappers,
			);
		}
		const editNode = findChild(resolutionOrEdit, GrammarAstNodeType.Edit);
		if (editNode) {
			const edits = translateEdits([editNode], localContext);
			return wrapNodes(wrappers, edits);
		}
	}

	const editsNode = findChild(node, GrammarAstNodeType.Edits);
	if (editsNode) {
		const edits = translateEdits(
			findChildren(editsNode, GrammarAstNodeType.Edit),
			localContext,
		);
		return wrapNodes(wrappers, edits);
	}

	return [];
}

function translateResolution(
	resolution: ResolutionAst,
	context: TranslationContext,
	inheritedWrappers: WrapperSpec[],
): TreeChild[] {
	const localWrappers: WrapperSpec[] = [];
	let localContext = context;

	if (resolution.textLocation) {
		const restriction = parseTextLocation(resolution.textLocation, context);
		if (restriction) {
			localWrappers.push({ type: "restriction", restriction });
			if (restriction.kind === LocationRestrictionKind.In) {
				localContext = {
					...localContext,
					moveFromRefs: restriction.refs,
				};
			}
		}
	}

	const edits = translateEdits(resolution.editList, localContext);
	return wrapNodes([...inheritedWrappers, ...localWrappers], edits);
}

function translateEdits(
	edits: RuleAst<GrammarAstNodeType.Edit>[],
	context: TranslationContext,
): EditNode[] {
	const nodes: EditNode[] = [];
	for (const editNode of edits) {
		const edit = parseEdit(editNode, context);
		if (!edit) continue;
		nodes.push({
			type: SemanticNodeType.Edit,
			edit,
		});
	}
	return nodes;
}

function parseEdit(
	editNode: RuleAst<GrammarAstNodeType.Edit>,
	context: TranslationContext,
): UltimateEdit | null {
	const normalized = findChild(editNode, GrammarAstNodeType.Edit) ?? editNode;
	const text = normalized.text.trim();

	if (text.startsWith("to read as follows:")) {
		return {
			kind: UltimateEditKind.Rewrite,
			content: extractContent(normalized),
		};
	}

	if (text.startsWith("striking ")) {
		const strikingSpec = findChild(normalized, GrammarAstNodeType.StrikingSpec);
		const strikingTarget = strikingSpec
			? findChild(strikingSpec, GrammarAstNodeType.StrikingTarget)
			: null;
		const target = strikingTarget
			? parseStrikingTarget(strikingTarget, context)
			: ({
					kind: SearchTargetKind.Text,
					text: text.slice("striking ".length),
				} as const);

		const insertingSpec = findChild(
			normalized,
			GrammarAstNodeType.InsertingSpec,
		);
		if (insertingSpec) {
			return {
				kind: UltimateEditKind.StrikeInsert,
				strike: target,
				insert: extractContent(insertingSpec),
			};
		}

		const followingSpec = findChild(
			normalized,
			GrammarAstNodeType.FollowingSpec,
		);
		const through = followingSpec
			? parseThroughSpec(
					findChild(followingSpec, GrammarAstNodeType.ThroughSpec),
				)
			: undefined;
		return {
			kind: UltimateEditKind.Strike,
			target,
			through,
		};
	}

	if (text.startsWith("amending ")) {
		const target = parseStructuralReferenceFromNode(
			findChild(normalized, GrammarAstNodeType.SubLocationOrSub),
			context,
		);
		return {
			kind: UltimateEditKind.Rewrite,
			target: target ?? undefined,
			content: extractContent(normalized),
		};
	}

	if (text.startsWith("adding after ")) {
		const targetRef = parseStructuralReferenceFromNode(
			findChild(normalized, GrammarAstNodeType.SubLocationOrSub),
			context,
		);
		return {
			kind: UltimateEditKind.Insert,
			content: extractContent(normalized),
			after: targetRef ? { ref: targetRef } : undefined,
		};
	}

	if (text.startsWith("adding at the end the following")) {
		return {
			kind: UltimateEditKind.Insert,
			content: extractContent(normalized),
			atEndOf: context.scopePath.length
				? {
						kind:
							context.scopePath[context.scopePath.length - 1]?.kind ??
							ScopeKind.Section,
						path: context.scopePath,
					}
				: undefined,
		};
	}

	if (text.startsWith("adding ") && text.includes(" at the end")) {
		const targetRef = parseStructuralReferenceFromNode(
			findChild(normalized, GrammarAstNodeType.SubLocationOrSub),
			context,
		);
		return {
			kind: UltimateEditKind.Insert,
			content: extractInlineContent(normalized),
			atEndOf:
				targetRef ??
				(context.scopePath.length
					? {
							kind:
								context.scopePath[context.scopePath.length - 1]?.kind ??
								ScopeKind.Section,
							path: context.scopePath,
						}
					: undefined),
		};
	}

	if (text.startsWith("inserting ")) {
		const content =
			extractInlineContent(normalized) || extractContent(normalized);
		const targetNode =
			findChild(normalized, GrammarAstNodeType.AfterBeforeTarget) ??
			findChild(normalized, GrammarAstNodeType.AfterBeforeSearch);
		const target = parseEditTarget(targetNode, context);
		const direction = normalized.tokens.some((token) =>
			token.includes(" before "),
		)
			? "before"
			: "after";
		if (text.includes(" at the end of ")) {
			const atEndOf = parseStructuralReferenceFromNode(
				findChild(normalized, GrammarAstNodeType.SubLocationOrSub),
				context,
			);
			return {
				kind: UltimateEditKind.Insert,
				content,
				atEndOf: atEndOf ?? undefined,
			};
		}
		return {
			kind: UltimateEditKind.Insert,
			content,
			before: direction === "before" ? target : undefined,
			after: direction === "after" ? target : undefined,
		};
	}

	if (text.startsWith("redesignating ")) {
		const pairs = findChildren(
			normalized,
			GrammarAstNodeType.SubLocationOrPlural,
		).map((node) => parseSubLocationOrPlural(node, context));
		const from = pairs[0] ?? [];
		const to = pairs[1] ?? [];
		const count = Math.min(from.length, to.length);
		if (count === 0) return null;
		if (from.length !== to.length) {
			pushIssue(
				context,
				"Redesignation source/destination counts differ; truncating to shortest list.",
				normalized,
			);
		}
		return {
			kind: UltimateEditKind.Redesignate,
			mappings: from.slice(0, count).map((source, index) => ({
				from: source,
				to: to[index] ?? source,
			})),
			respectively: text.includes("respectively"),
		};
	}

	if (text.startsWith("moving such sections ")) {
		const anchor = parseStructuralReferenceFromNode(
			findChild(normalized, GrammarAstNodeType.SubLocation),
			context,
		);
		const from = context.moveFromRefs ?? [];
		if (from.length === 0) {
			pushIssue(
				context,
				"Move edit references “such sections” but no plural source context was found.",
				normalized,
			);
		}
		return {
			kind: UltimateEditKind.Move,
			from,
			before: normalized.tokens.some((token) => token.includes("before "))
				? (anchor ?? undefined)
				: undefined,
			after: normalized.tokens.some((token) => token.includes("after "))
				? (anchor ?? undefined)
				: undefined,
		};
	}

	pushIssue(context, `Unsupported edit form: ${text}`, normalized);
	return null;
}

function parseStrikingTarget(
	node: RuleAst<GrammarAstNodeType.StrikingTarget>,
	context: TranslationContext,
): EditTarget {
	const strikingSearch = findChild(node, GrammarAstNodeType.StrikingSearch);
	if (strikingSearch) {
		const inline = findChild(strikingSearch, GrammarAstNodeType.Inline);
		const appearances = findChild(
			strikingSearch,
			GrammarAstNodeType.Appearances,
		);
		if (!inline) {
			return { kind: SearchTargetKind.Text, text: strikingSearch.text.trim() };
		}
		return {
			kind: SearchTargetKind.Text,
			text: extractInlineContent(inline),
			eachPlaceItAppears: appearances
				? appearances.text.includes("each place it appears") ||
					appearances.text.includes("both places it appears")
				: undefined,
		};
	}

	const inner = findChild(node, GrammarAstNodeType.InnerLocation);
	if (inner) return parseInnerLocationEditTarget(inner, context);

	const ref =
		parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SubLocationOrSub),
			context,
		) ??
		parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SubLocationOrPlural),
			context,
		);
	if (ref) return { ref };

	const inline = findChild(node, GrammarAstNodeType.Inline);
	if (inline)
		return { kind: SearchTargetKind.Text, text: extractInlineContent(inline) };

	return { kind: SearchTargetKind.Text, text: node.text.trim() };
}

function parseThroughSpec(
	node: RuleAst<GrammarAstNodeType.ThroughSpec> | null,
): EditTarget | undefined {
	if (!node) return undefined;
	const inline = findChild(node, GrammarAstNodeType.Inline);
	if (inline)
		return { kind: SearchTargetKind.Text, text: extractInlineContent(inline) };

	if (node.text.includes("period")) {
		return { punctuation: PunctuationKind.Period };
	}
	return undefined;
}

function parseEditTarget(
	node: RuleAst | null,
	context: TranslationContext,
): EditTarget {
	if (!node) return { kind: SearchTargetKind.Text, text: "" };
	const inline = findChild(node, GrammarAstNodeType.Inline);
	if (inline)
		return { kind: SearchTargetKind.Text, text: extractInlineContent(inline) };

	const inner = findChild(node, GrammarAstNodeType.InnerLocation);
	if (inner) return parseInnerLocationEditTarget(inner, context);

	const structural =
		parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SubLocationOrSub),
			context,
		) ??
		parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SectionLocationOrSub),
			context,
		) ??
		parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SubLocation),
			context,
		);
	if (structural) return { ref: structural };

	return { kind: SearchTargetKind.Text, text: node.text.trim() };
}

function parseTextLocation(
	node: RuleAst<GrammarAstNodeType.TextLocation>,
	context: TranslationContext,
): LocationRestriction | null {
	const text = node.text.trim();
	const anchor = parseTextLocationAnchor(
		findChild(node, GrammarAstNodeType.TextLocationAnchor),
		context,
	);
	const ordinalNode = findChild(node, GrammarAstNodeType.Ordinal);
	if (ordinalNode && text.includes(" sentence")) {
		const ordinal = ORDINAL_TO_NUMBER[ordinalNode.text.trim().toLowerCase()];
		if (!ordinal) return null;
		return {
			kind: LocationRestrictionKind.SentenceOrdinal,
			ordinal,
			anchor: anchor ?? undefined,
		};
	}

	if (text.startsWith("in the last sentence")) {
		return {
			kind: LocationRestrictionKind.SentenceLast,
			anchor: anchor ?? undefined,
		};
	}

	if (text.startsWith("in the heading")) {
		return {
			kind: LocationRestrictionKind.Heading,
			anchor: anchor ?? undefined,
		};
	}

	if (text.includes(" heading")) {
		const subName = findChild(node, GrammarAstNodeType.SubName);
		const scopeKind = subName ? scopeKindFromText(subName.text) : null;
		if (scopeKind) {
			return {
				kind: LocationRestrictionKind.SubLocationHeading,
				scopeKind,
				anchor: anchor ?? undefined,
			};
		}
	}

	if (text.startsWith("in the matter preceding ")) {
		const ref = parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SubLocation),
			context,
		);
		if (!ref) return null;
		return {
			kind: LocationRestrictionKind.MatterPreceding,
			ref,
		};
	}

	if (text.startsWith("in the matter following ")) {
		const ref = parseStructuralReferenceFromNode(
			findChild(node, GrammarAstNodeType.SubLocation),
			context,
		);
		if (!ref) return null;
		return {
			kind: LocationRestrictionKind.MatterFollowing,
			ref,
		};
	}

	if (text.startsWith("in ")) {
		const refs = parseInReferences(node, context);
		return {
			kind: LocationRestrictionKind.In,
			refs,
			anchor: anchor ?? undefined,
		};
	}

	if (text.startsWith("before ")) {
		const inner = findChild(node, GrammarAstNodeType.InnerLocation);
		if (!inner) return null;
		return {
			kind: LocationRestrictionKind.Before,
			target: parseInnerLocationTarget(inner, context),
		};
	}

	if (text.startsWith("after ")) {
		const inner = findChild(node, GrammarAstNodeType.InnerLocation);
		if (!inner) return null;
		return {
			kind: LocationRestrictionKind.After,
			target: parseInnerLocationTarget(inner, context),
		};
	}

	pushIssue(context, `Unsupported text location form: ${text}`, node);
	return null;
}

function parseSubscopeWrappers(
	node: RuleAst<GrammarAstNodeType.SubHead>,
	context: TranslationContext,
): { wrappers: WrapperSpec[]; context: TranslationContext } {
	const wrappers: WrapperSpec[] = [];
	let nextContext = context;

	const subscope = findChild(node, GrammarAstNodeType.Subscope);
	if (subscope) {
		const refs = findChildren(
			subscope,
			GrammarAstNodeType.SubLocationOrSub,
		).map((child) => parseSubLocationOrSub(child, context));
		const concrete = refs.filter((ref): ref is StructuralReference => !!ref);
		if (concrete.length > 0) {
			const mergedPath = mergeScopePaths(context.scopePath, concrete[0].path);
			const appended = mergedPath.slice(context.scopePath.length);
			for (const selector of appended) {
				wrappers.push({ type: "scope", scope: selector });
			}
			nextContext = {
				...nextContext,
				scopePath: mergedPath,
			};
		}
	}

	const subscopePlural = findChild(node, GrammarAstNodeType.SubscopePlural);
	if (subscopePlural) {
		const refs = parsePluralScopeList(subscopePlural, context);
		if (refs.length > 0) {
			const restriction: LocationRestriction = {
				kind: LocationRestrictionKind.In,
				refs,
			};
			wrappers.push({ type: "restriction", restriction });
			nextContext = {
				...nextContext,
				moveFromRefs: refs,
			};
		}
	}

	return { wrappers, context: nextContext };
}

function parseInReferences(
	node: RuleAst<GrammarAstNodeType.TextLocation>,
	context: TranslationContext,
): StructuralReference[] {
	const direct = parseStructuralReferenceFromNode(
		findChild(node, GrammarAstNodeType.SubLocationOrSub),
		context,
	);
	if (direct) return [direct];

	const pluralName = findChild(node, GrammarAstNodeType.SubNamePlural);
	const list = findChild(node, GrammarAstNodeType.SubLocationList);
	if (pluralName && list) {
		const ids = findChildren(list, GrammarAstNodeType.SubId).map((id) =>
			normalizeSubId(id.text),
		);
		const kind = scopeKindFromPluralText(pluralName.text);
		if (!kind) return [];
		return ids.map((label) => ({
			kind,
			path: [{ kind, label }],
		}));
	}

	return [];
}

function parsePluralScopeList(
	node: RuleAst<GrammarAstNodeType.SubscopePlural>,
	context: TranslationContext,
): StructuralReference[] {
	const plural = findChild(node, GrammarAstNodeType.SubNamePlural);
	const list = findChild(node, GrammarAstNodeType.SubLocationList);
	if (!plural || !list) return [];
	const kind = scopeKindFromPluralText(plural.text);
	if (!kind) return [];
	const ids = findChildren(list, GrammarAstNodeType.SubId).map((id) =>
		normalizeSubId(id.text),
	);
	return ids.map((label) => ({
		kind,
		path: mergeScopePaths(context.scopePath, [{ kind, label }]),
	}));
}

function parseTextLocationAnchor(
	node: RuleAst<GrammarAstNodeType.TextLocationAnchor> | null,
	context: TranslationContext,
) {
	if (!node) return null;
	if (node.text.includes("thereof")) {
		return { kind: TextLocationAnchorKind.Thereof } as const;
	}
	const ref = parseStructuralReferenceFromNode(
		findChild(node, GrammarAstNodeType.SubLocationOrSub),
		context,
	);
	if (!ref) return null;
	return { kind: TextLocationAnchorKind.Of, ref } as const;
}

function parseInnerLocationEditTarget(
	node: RuleAst<GrammarAstNodeType.InnerLocation>,
	context: TranslationContext,
): EditTarget {
	const target = parseInnerLocationTarget(node, context);
	if (target.kind === InnerLocationTargetKind.Punctuation) {
		return { punctuation: target.punctuation };
	}
	return { inner: target };
}

function parseInnerLocationTarget(
	node: RuleAst<GrammarAstNodeType.InnerLocation>,
	context: TranslationContext,
): InnerLocationTarget {
	const text = node.text.trim();
	if (text.includes("the period")) {
		return {
			kind: InnerLocationTargetKind.Punctuation,
			punctuation: PunctuationKind.Period,
			atEndOf:
				parseStructuralReferenceFromNode(
					findChild(node, GrammarAstNodeType.SubLocationOrSub),
					context,
				) ?? undefined,
		};
	}
	if (text.includes("the semicolon")) {
		return {
			kind: InnerLocationTargetKind.Punctuation,
			punctuation: PunctuationKind.Semicolon,
			atEndOf:
				parseStructuralReferenceFromNode(
					findChild(node, GrammarAstNodeType.SubLocationOrSub),
					context,
				) ?? undefined,
		};
	}
	if (text.includes("the comma")) {
		return {
			kind: InnerLocationTargetKind.Punctuation,
			punctuation: PunctuationKind.Comma,
			atEndOf:
				parseStructuralReferenceFromNode(
					findChild(node, GrammarAstNodeType.SubLocationOrSub),
					context,
				) ?? undefined,
		};
	}
	if (text === "the heading") {
		return { kind: InnerLocationTargetKind.Heading };
	}
	if (text === "the subsection heading") {
		return { kind: InnerLocationTargetKind.SubsectionHeading };
	}
	if (text === "the section designation") {
		return { kind: InnerLocationTargetKind.SectionDesignation };
	}
	const ordinal = findChild(node, GrammarAstNodeType.Ordinal);
	if (ordinal) {
		return {
			kind: InnerLocationTargetKind.SentenceOrdinal,
			ordinal: ORDINAL_TO_NUMBER[ordinal.text.trim().toLowerCase()] ?? 1,
		};
	}
	if (text === "the last sentence") {
		return { kind: InnerLocationTargetKind.SentenceLast };
	}

	pushIssue(context, `Unsupported inner location: ${text}`, node);
	return { kind: InnerLocationTargetKind.Heading };
}

function parseSubLocationOrPlural(
	node: RuleAst<GrammarAstNodeType.SubLocationOrPlural>,
	context: TranslationContext,
): StructuralReference[] {
	const direct = parseStructuralReferenceFromNode(
		findChild(node, GrammarAstNodeType.SubLocation),
		context,
	);
	if (direct) return [direct];

	const plural = findChild(node, GrammarAstNodeType.SubLocationsPlural);
	if (!plural) return [];
	const pluralKindNode = findChild(plural, GrammarAstNodeType.SubNamePlural);
	const kind = pluralKindNode
		? scopeKindFromPluralText(pluralKindNode.text)
		: null;
	if (!kind) return [];
	const ids = findChildren(plural, GrammarAstNodeType.SubId).map((id) =>
		normalizeSubId(id.text),
	);
	const refs = ids.map((label) => ({
		kind,
		path: [{ kind, label }],
	}));
	const container = parseStructuralReferenceFromNode(
		findChild(node, GrammarAstNodeType.SubLocation),
		context,
	);
	if (!container) return refs;
	return refs.map((ref) => ({
		kind: ref.kind,
		path: mergeScopePaths(container.path, ref.path),
	}));
}

function parseStructuralReferenceFromNode(
	node: RuleAst | null,
	context: TranslationContext,
): StructuralReference | null {
	if (!node) return null;
	if (node.type === GrammarAstNodeType.SubLocationOrSub) {
		return parseSubLocationOrSub(
			node as RuleAst<GrammarAstNodeType.SubLocationOrSub>,
			context,
		);
	}
	if (node.type === GrammarAstNodeType.SubLocation) {
		return parseSubLocation(node as RuleAst<GrammarAstNodeType.SubLocation>);
	}
	if (node.type === GrammarAstNodeType.SectionLocationOrSub) {
		const sectionOrSub = findChild(node, GrammarAstNodeType.SectionOrSub);
		if (sectionOrSub) return parseSectionOrSub(sectionOrSub);
		const subLocation = findChild(node, GrammarAstNodeType.SubLocationOrSub);
		if (subLocation) return parseSubLocationOrSub(subLocation, context);
	}
	if (node.type === GrammarAstNodeType.SubLocationOrPlural) {
		const refs = parseSubLocationOrPlural(
			node as RuleAst<GrammarAstNodeType.SubLocationOrPlural>,
			context,
		);
		return refs[0] ?? null;
	}
	if (node.type === GrammarAstNodeType.SectionOrSub) {
		return parseSectionOrSub(node as RuleAst<GrammarAstNodeType.SectionOrSub>);
	}

	const nested =
		findChild(node, GrammarAstNodeType.SubLocationOrSub) ??
		findChild(node, GrammarAstNodeType.SubLocation) ??
		findChild(node, GrammarAstNodeType.SectionOrSub);
	return nested ? parseStructuralReferenceFromNode(nested, context) : null;
}

function parseSectionOrSub(
	node: RuleAst<GrammarAstNodeType.SectionOrSub>,
): StructuralReference {
	const sectionId =
		findChild(node, GrammarAstNodeType.SectionId)?.text.trim() ?? "";
	const subIds = findChildren(
		findChild(node, GrammarAstNodeType.SubsectionOrSub),
		GrammarAstNodeType.SubId,
	).map((id) => normalizeSubId(id.text));

	const path: ScopeSelector[] = [];
	if (sectionId.length > 0) {
		path.push({ kind: ScopeKind.Section, label: sectionId });
	}
	let currentKind = ScopeKind.Subsection;
	for (const label of subIds) {
		path.push({ kind: currentKind, label });
		currentKind = nextScopeKind(currentKind);
	}
	return {
		kind: path[path.length - 1]?.kind ?? ScopeKind.Section,
		path,
	};
}

function parseSubLocationOrSub(
	node: RuleAst<GrammarAstNodeType.SubLocationOrSub>,
	context: TranslationContext,
): StructuralReference | null {
	const subNameNode = findChild(node, GrammarAstNodeType.SubName);
	const subIds = findChildren(
		findChild(node, GrammarAstNodeType.SubsectionOrSub),
		GrammarAstNodeType.SubId,
	).map((id) => normalizeSubId(id.text));
	const firstKind = subNameNode ? scopeKindFromText(subNameNode.text) : null;
	if (!firstKind || subIds.length === 0) {
		pushIssue(context, "Unable to parse sub-location selector.", node);
		return null;
	}

	let kind = firstKind;
	const path: ScopeSelector[] = [];
	for (const label of subIds) {
		path.push({ kind, label });
		kind = nextScopeKind(kind);
	}
	return {
		kind: path[path.length - 1]?.kind ?? firstKind,
		path,
	};
}

function parseSubLocationOrSubCaps(
	node: RuleAst<GrammarAstNodeType.SubLocationOrSubCaps>,
): StructuralReference | null {
	const subNameNode = findChild(node, GrammarAstNodeType.SubNameCaps);
	const subIds = findChildren(
		findChild(node, GrammarAstNodeType.SubsectionOrSub),
		GrammarAstNodeType.SubId,
	).map((id) => normalizeSubId(id.text));
	const firstKind = subNameNode ? scopeKindFromText(subNameNode.text) : null;
	if (!firstKind || subIds.length === 0) {
		return null;
	}

	let kind = firstKind;
	const path: ScopeSelector[] = [];
	for (const label of subIds) {
		path.push({ kind, label });
		kind = nextScopeKind(kind);
	}
	return {
		kind: path[path.length - 1]?.kind ?? firstKind,
		path,
	};
}

function parseSubLocation(
	node: RuleAst<GrammarAstNodeType.SubLocation>,
): StructuralReference | null {
	const subNameNode = findChild(node, GrammarAstNodeType.SubName);
	const subIdNode = findChild(node, GrammarAstNodeType.SubId);
	if (!subNameNode || !subIdNode) return null;
	const kind = scopeKindFromText(subNameNode.text);
	if (!kind) return null;
	return {
		kind,
		path: [{ kind, label: normalizeSubId(subIdNode.text) }],
	};
}

function extractTargetSection(
	targetScopePath: TargetScopeSegment[] | undefined,
): string | undefined {
	const sectionScope = targetScopePath?.find(
		(scope): scope is ScopeSelector => scope.kind === ScopeKind.Section,
	);
	return sectionScope?.label;
}

function extractTargetScopePath(
	parentNode: RuleAst<GrammarAstNodeType.Parent>,
	issues: TranslationIssue[],
): TargetScopeSegment[] | undefined {
	const uscScope = extractUscScopePath(parentNode);
	if (uscScope) return uscScope;

	const structuralScope = extractLocatorStructuralScope(parentNode);
	const hasSection = structuralScope.some(
		(scope) => scope.kind === ScopeKind.Section,
	);
	const codificationReference = extractCodificationReference(parentNode);
	const contextReference =
		codificationReference ?? extractCodeOrActReference(parentNode);

	if (!contextReference || !hasSection) {
		issues.push({
			message:
				"Unable to derive target scope path with both top-level context reference and section.",
			nodeType: GrammarAstNodeType.Parent,
			sourceText: parentNode.text,
		});
	}

	if (contextReference && hasSection) {
		return [contextReference, ...structuralScope];
	}
	return undefined;
}

function extractCodificationReference(
	parentNode: RuleAst<GrammarAstNodeType.Parent>,
): TargetScopeSegment | null {
	const codification = findChild(parentNode, GrammarAstNodeType.Codification);
	if (!codification) return null;

	const uscRef = findChildDeep(codification, GrammarAstNodeType.UscRef);
	if (uscRef) {
		const titleMatch = uscRef.text.match(USC_TITLE_REFERENCE_RE);
		if (titleMatch?.[1]) {
			return { kind: "code_reference", label: `${titleMatch[1]} U.S.C.` };
		}
	}

	const pubLawRef = findChildDeep(codification, GrammarAstNodeType.PubLawRef);
	if (pubLawRef?.text.trim()) {
		return { kind: "act_reference", label: pubLawRef.text.trim() };
	}

	const statRef = findChildDeep(codification, GrammarAstNodeType.StatRef);
	if (statRef?.text.trim()) {
		return { kind: "act_reference", label: statRef.text.trim() };
	}

	return null;
}

function extractUscScopePath(
	parentNode: RuleAst<GrammarAstNodeType.Parent>,
): TargetScopeSegment[] | null {
	const uscRef = findChildDeep(parentNode, GrammarAstNodeType.UscRef);
	if (!uscRef) return null;

	const titleMatch = uscRef.text.match(USC_TITLE_REFERENCE_RE);
	const title = titleMatch?.[1];
	if (!title) return null;

	const uscSectionOrSub = findChildDeep(
		uscRef,
		GrammarAstNodeType.SectionOrSub,
	);
	const structuralScope = uscSectionOrSub
		? parseSectionOrSub(uscSectionOrSub).path
		: [];
	if (structuralScope.length === 0) return null;

	return [
		{ kind: "code_reference", label: `${title} U.S.C.` },
		...structuralScope,
	];
}

function extractLocatorStructuralScope(
	parentNode: RuleAst<GrammarAstNodeType.Parent>,
): ScopeSelector[] {
	const initialLocator = findChild(
		parentNode,
		GrammarAstNodeType.InitialLocator,
	);
	if (!initialLocator) return [];

	const sectionOrSub = findChildDeep(
		initialLocator,
		GrammarAstNodeType.SectionOrSub,
	);
	const sectionPath = sectionOrSub ? parseSectionOrSub(sectionOrSub).path : [];

	const subLocationCaps = findChildDeep(
		initialLocator,
		GrammarAstNodeType.SubLocationOrSubCaps,
	);
	const subPath = subLocationCaps
		? (parseSubLocationOrSubCaps(subLocationCaps)?.path ?? [])
		: [];

	return mergeScopePaths(sectionPath, subPath);
}

function extractCodeOrActReference(
	parentNode: RuleAst<GrammarAstNodeType.Parent>,
): TargetScopeSegment | null {
	const underlying = findChild(parentNode, GrammarAstNodeType.Underlying);
	const titleCodeMatch = underlying?.text.match(USC_TITLE_UNDERLYING_RE);
	if (titleCodeMatch?.[1]) {
		return { kind: "code_reference", label: `${titleCodeMatch[1]} U.S.C.` };
	}
	if (underlying && INTERNAL_REVENUE_CODE_RE.test(underlying.text)) {
		return { kind: "code_reference", label: "26 U.S.C." };
	}

	const publicLawRef = findChildDeep(parentNode, GrammarAstNodeType.PubLawRef);
	const publicLawLabel = publicLawRef?.text.trim();
	if (publicLawLabel) {
		return { kind: "act_reference", label: publicLawLabel };
	}

	const actNode = findChildDeep(parentNode, GrammarAstNodeType.Act);
	const actLabel = actNode?.text.trim();
	if (actLabel && actLabel.length > 0) {
		return { kind: "act_reference", label: actLabel };
	}
	return null;
}

function extractInlineContent(node: RuleAst): string {
	const inline = findChildDeep(node, GrammarAstNodeType.Inline);
	if (!inline) return "";
	return normalizeQuotedText(inline.text);
}

function extractContent(node: RuleAst): string {
	const block = findChildDeep(node, GrammarAstNodeType.Block);
	if (block) return normalizeQuotedText(block.text);
	const inline = findChildDeep(node, GrammarAstNodeType.Inline);
	if (inline) return normalizeQuotedText(inline.text);
	return "";
}

function normalizeQuotedText(value: string): string {
	return value
		.split("\n")
		.map((line) => line.replace(/^“/, "").replace(/”$/, ""))
		.join("\n")
		.trim();
}

function wrapNodes(wrappers: WrapperSpec[], leaves: EditNode[]): TreeChild[] {
	if (leaves.length === 0) return [];
	let children: TreeChild[] = leaves;
	for (let index = wrappers.length - 1; index >= 0; index -= 1) {
		const wrapper = wrappers[index];
		if (!wrapper) continue;
		if (wrapper.type === "scope") {
			children = [
				{
					type: SemanticNodeType.Scope,
					scope: wrapper.scope,
					children,
				},
			];
			continue;
		}
		children = [
			{
				type: SemanticNodeType.LocationRestriction,
				restriction: wrapper.restriction,
				children: children.filter(
					(child): child is LocationRestrictionNode | EditNode =>
						child.type !== SemanticNodeType.Scope,
				),
			},
		];
	}
	return children;
}

function mergeScopePaths(
	base: ScopeSelector[],
	next: ScopeSelector[],
): ScopeSelector[] {
	if (next.length === 0) return base;
	const firstRank = scopeRank(next[0]?.kind ?? ScopeKind.Subsection);
	const merged = base.filter((item) => scopeRank(item.kind) < firstRank);
	return [...merged, ...next];
}

function scopeRank(kind: ScopeKind): number {
	return SCOPE_ORDER.indexOf(kind);
}

function nextScopeKind(kind: ScopeKind): ScopeKind {
	const index = SCOPE_ORDER.indexOf(kind);
	const next = SCOPE_ORDER[index + 1];
	return next ?? kind;
}

function normalizeSubId(value: string): string {
	return value.replace(/^\(/, "").replace(/\)$/, "");
}

function scopeKindFromPluralText(text: string): ScopeKind | null {
	return scopeKindFromText(text.replace(/s$/, ""));
}

function scopeKindFromText(text: string): ScopeKind | null {
	const normalized = text.trim().toLowerCase();
	if (normalized === "section") return ScopeKind.Section;
	if (normalized === "subsection") return ScopeKind.Subsection;
	if (normalized === "paragraph") return ScopeKind.Paragraph;
	if (normalized === "subparagraph") return ScopeKind.Subparagraph;
	if (normalized === "clause") return ScopeKind.Clause;
	if (normalized === "subclause") return ScopeKind.Subclause;
	if (normalized === "item") return ScopeKind.Item;
	if (normalized === "subitem") return ScopeKind.Subitem;
	return null;
}

function toResolutionAst(
	node: RuleAst<GrammarAstNodeType.Resolution>,
): ResolutionAst {
	const edits = findChild(node, GrammarAstNodeType.Edits);
	return {
		...node,
		amendmentSpec: findChild(node, GrammarAstNodeType.AmendmentSpec),
		textLocation: findChild(node, GrammarAstNodeType.TextLocation),
		edits,
		editList: edits ? findChildren(edits, GrammarAstNodeType.Edit) : [],
	};
}

function findChild<Name extends GrammarAstNodeType>(
	node: RuleAst | null | undefined,
	type: Name,
): RuleAst<Name> | null {
	if (!node) return null;
	const child = node.children.find((item) => item.type === type);
	return (child as RuleAst<Name> | undefined) ?? null;
}

function findChildren<Name extends GrammarAstNodeType>(
	node: RuleAst | null | undefined,
	type: Name,
): RuleAst<Name>[] {
	if (!node) return [];
	return node.children.filter((item) => item.type === type) as RuleAst<Name>[];
}

function findChildDeep<Name extends GrammarAstNodeType>(
	node: RuleAst | null | undefined,
	type: Name,
): RuleAst<Name> | null {
	if (!node) return null;
	if (node.type === type) return node as RuleAst<Name>;
	for (const child of node.children) {
		const found = findChildDeep(child, type);
		if (found) return found;
	}
	return null;
}

function pushIssue(
	context: TranslationContext,
	message: string,
	node: RuleAst,
): void {
	context.issues.push({
		message,
		nodeType: node.type,
		sourceText: node.text,
	});
}
