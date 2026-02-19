export enum SemanticNodeType {
	InstructionRoot = "instruction_root",
	Scope = "scope",
	LocationRestriction = "location_restriction",
	Edit = "edit",
}

export enum ScopeKind {
	Section = "section",
	Subsection = "subsection",
	Paragraph = "paragraph",
	Subparagraph = "subparagraph",
	Clause = "clause",
	Subclause = "subclause",
	Item = "item",
	Subitem = "subitem",
}

export enum LocationRestrictionKind {
	Heading = "heading",
	SubsectionHeading = "subsection_heading",
	SentenceOrdinal = "sentence_ordinal",
	SentenceLast = "sentence_last",
	MatterPreceding = "matter_preceding",
	MatterFollowing = "matter_following",
	AtEnd = "at_end",
	Before = "before",
	After = "after",
}

export enum SearchTargetKind {
	Text = "text",
	Structural = "structural",
	Punctuation = "punctuation",
}

export enum UltimateEditKind {
	Strike = "strike",
	Insert = "insert",
	StrikeInsert = "strike_insert",
	Rewrite = "rewrite",
	Redesignate = "redesignate",
	Move = "move",
}

export enum PunctuationKind {
	Period = "period",
	Comma = "comma",
	Semicolon = "semicolon",
}

export interface ScopeSelector {
	kind: ScopeKind;
	label: string;
}

export interface StructuralReference {
	kind: ScopeKind;
	path: ScopeSelector[];
}

export interface LocationRestriction {
	kind: LocationRestrictionKind;
	ordinal?: number;
	anchor?: EditTarget;
}

export interface TextSearchTarget {
	kind: SearchTargetKind.Text;
	text: string;
	eachPlaceItAppears?: boolean;
}

export interface StructuralEditTarget {
	ref: StructuralReference;
}

export interface PunctuationEditTarget {
	punctuation: PunctuationKind;
}

// SearchTarget is strictly textual search.
export type SearchTarget = TextSearchTarget;

// EditTarget includes non-textual structural anchors/targets.
export type EditTarget =
	| SearchTarget
	| StructuralEditTarget
	| PunctuationEditTarget;

export interface StrikeEdit {
	kind: UltimateEditKind.Strike;
	target: EditTarget;
	through?: EditTarget;
}

export interface InsertEdit {
	kind: UltimateEditKind.Insert;
	content: string;
	before?: EditTarget;
	after?: EditTarget;
	atEndOf?: StructuralReference;
}

export interface StrikeInsertEdit {
	kind: UltimateEditKind.StrikeInsert;
	strike: EditTarget;
	insert: string;
}

export interface RewriteEdit {
	kind: UltimateEditKind.Rewrite;
	target?: StructuralReference;
	content: string;
}

export interface RedesignateMapping {
	from: StructuralReference;
	to: StructuralReference;
}

export interface RedesignateEdit {
	kind: UltimateEditKind.Redesignate;
	mappings: RedesignateMapping[];
	respectively?: boolean;
}

export interface MoveEdit {
	kind: UltimateEditKind.Move;
	from: StructuralReference;
	before?: StructuralReference;
	after?: StructuralReference;
}

export type UltimateEdit =
	| StrikeEdit
	| InsertEdit
	| StrikeInsertEdit
	| RewriteEdit
	| RedesignateEdit
	| MoveEdit;

export interface EditNode {
	type: SemanticNodeType.Edit;
	edit: UltimateEdit;
}

export interface LocationRestrictionNode {
	type: SemanticNodeType.LocationRestriction;
	restriction: LocationRestriction;
	children: Array<LocationRestrictionNode | EditNode>;
}

export interface ScopeNode {
	type: SemanticNodeType.Scope;
	scope: ScopeSelector;
	children: Array<ScopeNode | LocationRestrictionNode | EditNode>;
}

export interface InstructionSemanticTree {
	type: SemanticNodeType.InstructionRoot;
	targetSection?: string;
	children: Array<ScopeNode | LocationRestrictionNode | EditNode>;
}
