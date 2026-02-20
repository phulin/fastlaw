import type {
	PunctuationKind,
	TextWithProvenance,
} from "./amendment-edit-tree";
import type { MarkdownReplacementRange } from "./markdown";

export type HierarchyLevelType =
	| "section"
	| "subsection"
	| "paragraph"
	| "subparagraph"
	| "clause"
	| "subclause"
	| "item"
	| "subitem";

export interface HierarchyLevel {
	type: HierarchyLevelType;
	val: string;
}

export type InstructionOperation =
	| {
			type: "replace";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			throughTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: TextWithProvenance;
			strikingContent?: string;
			eachPlaceItAppears?: boolean;
			throughContent?: string;
			throughPunctuation?: PunctuationKind;
	  }
	| {
			type: "delete";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			throughTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			strikingContent?: string;
			eachPlaceItAppears?: boolean;
			throughContent?: string;
			throughPunctuation?: PunctuationKind;
	  }
	| {
			type: "insert_before";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: TextWithProvenance;
			anchorContent?: string;
			anchorTarget?: HierarchyLevel[];
	  }
	| {
			type: "insert_after";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: TextWithProvenance;
			anchorContent?: string;
			anchorTarget?: HierarchyLevel[];
	  }
	| {
			type: "insert";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: TextWithProvenance;
	  }
	| {
			type: "add_at_end";
			target?: HierarchyLevel[];
			matterPrecedingTarget?: HierarchyLevel[];
			matterFollowingTarget?: HierarchyLevel[];
			sentenceOrdinal?: number;
			content?: TextWithProvenance;
	  }
	| {
			type: "redesignate";
			target: HierarchyLevel[];
			fromLabel: string;
			toLabel: string;
	  }
	| {
			type: "move";
			fromTargets: HierarchyLevel[][];
			beforeTarget?: HierarchyLevel[];
			afterTarget?: HierarchyLevel[];
	  };

export interface InstructionNode {
	operation: InstructionOperation;
	children: InstructionNode[];
	text: string;
}

export interface ScopeRange {
	start: number;
	end: number;
	targetLevel: number | null;
}

export interface StructuralNode {
	id: string;
	kind: HierarchyLevelType;
	label: string;
	path: HierarchyLevel[];
	start: number;
	end: number;
	targetLevel: number;
	childIds: string[];
}

export interface DocumentModel {
	sourceText: string;
	rootRange: ScopeRange;
	nodesById: Map<string, StructuralNode>;
	rootNodeIds: string[];
}

export interface ResolutionIssue {
	operationIndex: number;
	kind:
		| "target_unresolved"
		| "target_ambiguous"
		| "through_target_unresolved"
		| "through_target_ambiguous"
		| "anchor_target_unresolved"
		| "anchor_target_ambiguous"
		| "move_from_unresolved"
		| "move_from_ambiguous"
		| "move_anchor_unresolved"
		| "move_anchor_ambiguous"
		| "matter_preceding_target_unresolved"
		| "matter_preceding_target_ambiguous"
		| "matter_following_target_unresolved"
		| "matter_following_target_ambiguous";
	path: string;
	candidateNodeIds?: string[];
}

export interface ResolvedInstructionOperation {
	operationIndex: number;
	nodeText: string;
	operation: InstructionOperation;
	hasExplicitTargetPath: boolean;
	targetPathText: string | null;
	resolvedTargetId: string | null;
	resolvedMatterPrecedingTargetId: string | null;
	resolvedMatterFollowingTargetId: string | null;
	resolvedThroughTargetId: string | null;
	resolvedAnchorTargetId: string | null;
	resolvedMoveFromIds: Array<string | null>;
	resolvedMoveAnchorId: string | null;
}

export interface OperationMatchAttempt {
	operationType: string;
	nodeText: string;
	strikingContent: string | null;
	targetPath: string | null;
	hasExplicitTargetPath: boolean;
	scopedRange: {
		start: number;
		end: number;
		length: number;
		preview: string;
	} | null;
	searchText: string | null;
	searchTextKind: "striking" | "anchor_before" | "anchor_after" | "none";
	searchIndex: number | null;
	patchApplied: boolean;
	outcome: "applied" | "no_patch" | "scope_unresolved";
}

export interface PlannedPatch {
	operationIndex: number;
	start: number;
	end: number;
	deleted: string;
	inserted: TextWithProvenance;
	insertedPrefix?: string;
	insertedSuffix?: string;
}

export interface PlanEditsResult {
	patches: PlannedPatch[];
	attempts: OperationMatchAttempt[];
}

export interface ApplyPlannedPatchesResult {
	text: string;
	replacements: MarkdownReplacementRange[];
}
