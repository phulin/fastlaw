import type { ParagraphRange } from "./types";

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
	SubLocationHeading = "sub_location_heading",
	SubsectionHeading = "subsection_heading",
	SentenceOrdinal = "sentence_ordinal",
	SentenceLast = "sentence_last",
	MatterPreceding = "matter_preceding",
	MatterFollowing = "matter_following",
	In = "in",
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

export interface CodeReferenceTargetScopeSegment {
	kind: "code_reference";
	label: string;
}

export interface ActReferenceTargetScopeSegment {
	kind: "act_reference";
	label: string;
}

export interface StructuralTargetScopeSegment {
	kind: ScopeKind;
	label: string;
}

export type TargetScopeSegment =
	| CodeReferenceTargetScopeSegment
	| ActReferenceTargetScopeSegment
	| StructuralTargetScopeSegment;

export interface StructuralReference {
	kind: ScopeKind;
	path: ScopeSelector[];
}

export enum TextLocationAnchorKind {
	Thereof = "thereof",
	Of = "of",
}

export interface ThereofTextLocationAnchor {
	kind: TextLocationAnchorKind.Thereof;
}

export interface OfTextLocationAnchor {
	kind: TextLocationAnchorKind.Of;
	ref: StructuralReference;
}

export type TextLocationAnchor =
	| ThereofTextLocationAnchor
	| OfTextLocationAnchor;

export enum InnerLocationTargetKind {
	Punctuation = "punctuation",
	Heading = "heading",
	SubsectionHeading = "subsection_heading",
	SectionDesignation = "section_designation",
	SentenceOrdinal = "sentence_ordinal",
	SentenceLast = "sentence_last",
}

export interface PunctuationInnerLocationTarget {
	kind: InnerLocationTargetKind.Punctuation;
	punctuation: PunctuationKind;
	atEndOf?: StructuralReference;
}

export interface HeadingInnerLocationTarget {
	kind: InnerLocationTargetKind.Heading;
}

export interface SubsectionHeadingInnerLocationTarget {
	kind: InnerLocationTargetKind.SubsectionHeading;
}

export interface SectionDesignationInnerLocationTarget {
	kind: InnerLocationTargetKind.SectionDesignation;
}

export interface SentenceOrdinalInnerLocationTarget {
	kind: InnerLocationTargetKind.SentenceOrdinal;
	ordinal: number;
}

export interface SentenceLastInnerLocationTarget {
	kind: InnerLocationTargetKind.SentenceLast;
}

export type InnerLocationTarget =
	| PunctuationInnerLocationTarget
	| HeadingInnerLocationTarget
	| SubsectionHeadingInnerLocationTarget
	| SectionDesignationInnerLocationTarget
	| SentenceOrdinalInnerLocationTarget
	| SentenceLastInnerLocationTarget;

export interface HeadingLocationRestriction {
	kind: LocationRestrictionKind.Heading;
	anchor?: TextLocationAnchor;
}

export interface SubLocationHeadingRestriction {
	kind: LocationRestrictionKind.SubLocationHeading;
	scopeKind: ScopeKind;
	anchor?: TextLocationAnchor;
}

export interface SubsectionHeadingRestriction {
	kind: LocationRestrictionKind.SubsectionHeading;
	anchor?: TextLocationAnchor;
}

export interface SentenceOrdinalLocationRestriction {
	kind: LocationRestrictionKind.SentenceOrdinal;
	ordinal: number;
	anchor?: TextLocationAnchor;
}

export interface SentenceLastLocationRestriction {
	kind: LocationRestrictionKind.SentenceLast;
	anchor?: TextLocationAnchor;
}

export interface MatterPrecedingLocationRestriction {
	kind: LocationRestrictionKind.MatterPreceding;
	ref: StructuralReference;
}

export interface MatterFollowingLocationRestriction {
	kind: LocationRestrictionKind.MatterFollowing;
	ref: StructuralReference;
}

export interface InLocationRestriction {
	kind: LocationRestrictionKind.In;
	refs: StructuralReference[];
	anchor?: TextLocationAnchor;
}

export interface AtEndLocationRestriction {
	kind: LocationRestrictionKind.AtEnd;
	ref?: StructuralReference;
}

export interface BeforeLocationRestriction {
	kind: LocationRestrictionKind.Before;
	target: InnerLocationTarget;
}

export interface AfterLocationRestriction {
	kind: LocationRestrictionKind.After;
	target: InnerLocationTarget;
}

export type LocationRestriction =
	| HeadingLocationRestriction
	| SubLocationHeadingRestriction
	| SubsectionHeadingRestriction
	| SentenceOrdinalLocationRestriction
	| SentenceLastLocationRestriction
	| MatterPrecedingLocationRestriction
	| MatterFollowingLocationRestriction
	| InLocationRestriction
	| AtEndLocationRestriction
	| BeforeLocationRestriction
	| AfterLocationRestriction;

export interface TextWithProvenance {
	text: string;
	sourceLocation: ParagraphRange;
}

export interface TextSearchTarget {
	kind: SearchTargetKind.Text;
	text: TextWithProvenance;
	eachPlaceItAppears?: boolean;
}

export interface StructuralEditTarget {
	ref: StructuralReference;
}

export interface StructuralRangeEditTarget {
	refs: StructuralReference[];
}

export interface PunctuationEditTarget {
	punctuation: PunctuationKind;
}

export interface InnerLocationEditTarget {
	inner: InnerLocationTarget;
}

// SearchTarget is strictly textual search.
export type SearchTarget = TextSearchTarget;

// EditTarget includes non-textual structural anchors/targets.
export type EditTarget =
	| SearchTarget
	| StructuralEditTarget
	| StructuralRangeEditTarget
	| PunctuationEditTarget
	| InnerLocationEditTarget;

export interface StrikeEdit {
	kind: UltimateEditKind.Strike;
	target: EditTarget;
	through?: EditTarget;
}

export interface InsertEdit {
	kind: UltimateEditKind.Insert;
	content: TextWithProvenance;
	before?: EditTarget;
	after?: EditTarget;
	atEndOf?: StructuralReference;
}

export interface StrikeInsertEdit {
	kind: UltimateEditKind.StrikeInsert;
	strike: EditTarget;
	insert: TextWithProvenance;
}

export interface RewriteEdit {
	kind: UltimateEditKind.Rewrite;
	target?: StructuralReference;
	content: TextWithProvenance;
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
	from: StructuralReference[];
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

export function textSearchFromEditTarget(
	target: EditTarget,
): { text: string; eachPlaceItAppears: boolean } | null {
	if ("kind" in target && target.kind === SearchTargetKind.Text) {
		return {
			text: target.text.text,
			eachPlaceItAppears: target.eachPlaceItAppears ?? false,
		};
	}
	return null;
}

export function textFromEditTarget(target: EditTarget): string | null {
	return textSearchFromEditTarget(target)?.text ?? null;
}

export interface InstructionSemanticTree {
	type: SemanticNodeType.InstructionRoot;
	targetSection?: string;
	targetScopePath?: TargetScopeSegment[];
	children: Array<ScopeNode | LocationRestrictionNode | EditNode>;
}
