import { For, Show } from "solid-js";
import type {
	AmendmentEffect,
	AmendmentOperation,
	TextSegment,
} from "../lib/amendment-effect";

interface AmendedSnippetProps {
	effect: AmendmentEffect;
	compact?: boolean;
}

/**
 * Renders a single text segment with appropriate styling.
 */
function TextSegmentView(props: { segment: TextSegment }) {
	const segmentClass = () => {
		switch (props.segment.type) {
			case "inserted":
				return "amend-inserted";
			case "deleted":
				return "amend-deleted";
			default:
				return "amend-existing";
		}
	};

	return (
		<span class={segmentClass()}>
			<Show when={props.segment.hierarchyLabel}>
				<span class="amend-label">{props.segment.hierarchyLabel} </span>
			</Show>
			{props.segment.text}
		</span>
	);
}

/**
 * Renders the before/after diff for a modification.
 */
function DiffView(props: {
	before?: TextSegment[];
	after?: TextSegment[];
	compact?: boolean;
}) {
	return (
		<div class="amend-diff">
			<Show when={props.before && props.before.length > 0}>
				<div class="amend-diff-before">
					<span class="amend-diff-label">- </span>
					<For each={props.before}>
						{(segment) => <TextSegmentView segment={segment} />}
					</For>
				</div>
			</Show>
			<Show when={props.after && props.after.length > 0}>
				<div class="amend-diff-after">
					<span class="amend-diff-label">+ </span>
					<For each={props.after}>
						{(segment) => <TextSegmentView segment={segment} />}
					</For>
				</div>
			</Show>
		</div>
	);
}

/**
 * Renders inserted text for an insertion.
 */
function InsertionView(props: {
	inserted?: TextSegment[];
	position?: "before" | "after" | "end" | "replace";
}) {
	return (
		<div class="amend-insertion">
			<Show when={props.position && props.position !== "replace"}>
				<span class="amend-position-label">[Insert {props.position}]</span>
			</Show>
			<For each={props.inserted}>
				{(segment) => <TextSegmentView segment={segment} />}
			</For>
		</div>
	);
}

/**
 * Renders deleted text for a deletion.
 */
function DeletionView(props: { deleted?: TextSegment[] }) {
	return (
		<div class="amend-deletion">
			<span class="amend-diff-label">- </span>
			<For each={props.deleted}>
				{(segment) => <TextSegmentView segment={segment} />}
			</For>
		</div>
	);
}

/**
 * Renders a full section replacement.
 */
function FullReplacementView(props: {
	before?: TextSegment[];
	after?: TextSegment[];
}) {
	return (
		<div class="amend-full-replacement">
			<div class="amend-replacement-header">Section rewritten as follows:</div>
			<div class="amend-replacement-content">
				<For each={props.after}>
					{(segment) => (
						<div class="amend-replacement-line">
							<TextSegmentView segment={segment} />
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

/**
 * Renders a single operation within a multi-operation amendment.
 */
function OperationView(props: {
	operation: AmendmentOperation;
	index: number;
}) {
	const op = () => props.operation;

	return (
		<div class="amend-operation">
			<div class="amend-operation-header">
				Operation {props.index + 1}: {op().type}
			</div>
			<Show when={op().type === "modification"}>
				<DiffView before={op().before} after={op().after} />
			</Show>
			<Show when={op().type === "insertion"}>
				<InsertionView
					inserted={op().inserted}
					position={op().insertPosition}
				/>
			</Show>
			<Show when={op().type === "deletion"}>
				<DeletionView deleted={op().deleted} />
			</Show>
		</div>
	);
}

/**
 * Renders multiple operations.
 */
function MultipleOperationsView(props: { operations: AmendmentOperation[] }) {
	return (
		<div class="amend-multiple">
			<div class="amend-multiple-header">
				{props.operations.length} operations:
			</div>
			<For each={props.operations}>
				{(op, index) => <OperationView operation={op} index={index()} />}
			</For>
		</div>
	);
}

/**
 * Main component for rendering an amendment effect.
 * Shows the before/after state of the statutory text with visual diff highlighting.
 */
export function AmendedSnippet(props: AmendedSnippetProps) {
	const effectType = () => props.effect.effectType;

	return (
		<div class="amend-snippet">
			<Show when={props.effect.hasEdgeCase}>
				<div class="amend-edge-case-notice">
					<span class="amend-edge-case-icon">!</span>
					{props.effect.edgeCaseReason ?? "Edge case not yet supported"}
				</div>
			</Show>

			<Show when={!props.effect.hasEdgeCase}>
				<Show when={effectType() === "modification"}>
					<DiffView
						before={props.effect.before}
						after={props.effect.after}
						compact={props.compact}
					/>
				</Show>

				<Show when={effectType() === "insertion"}>
					<InsertionView
						inserted={props.effect.inserted}
						position={props.effect.insertPosition}
					/>
				</Show>

				<Show when={effectType() === "deletion"}>
					<DeletionView deleted={props.effect.deleted} />
				</Show>

				<Show when={effectType() === "full_replacement"}>
					<FullReplacementView
						before={props.effect.before}
						after={props.effect.after}
					/>
				</Show>

				<Show when={effectType() === "multiple"}>
					<MultipleOperationsView operations={props.effect.operations ?? []} />
				</Show>

				<Show when={effectType() === "unknown"}>
					<div class="amend-unknown">
						Unable to compute effect for this instruction.
					</div>
				</Show>
			</Show>
		</div>
	);
}
