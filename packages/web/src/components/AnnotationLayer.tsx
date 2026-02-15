import { createEffect, For, Show } from "solid-js";
import { renderMarkdown } from "../lib/markdown";
import { AmendedSnippet } from "./AmendedSnippet";
import type { InstructionPageItem, PageItem } from "./PageRow";

export interface PageLayout {
	pageOffset: number;
	pageHeight: number;
	pageWidth: number;
}

interface AnnotationLayerProps {
	items: { item: PageItem; globalTop: number; pageNumber: number }[];
	totalHeight: number;
	width: number; // The width of the annotation column
	onInstructionClick: (instructionItem: InstructionPageItem) => void;
}

const ITEM_GAP = 0;
const LEADING_MARKER_RE = /^\(([^)]+)\)/;

const extractLeadingMarkers = (text: string): string[] => {
	const markers: string[] = [];
	let remaining = text.trimStart();

	while (remaining.startsWith("(")) {
		const markerMatch = remaining.match(LEADING_MARKER_RE);
		if (!markerMatch) break;
		markers.push(markerMatch[0]);
		remaining = remaining.slice(markerMatch[0].length).trimStart();
	}

	return markers;
};

const renderInstructionMarkdown = (
	instruction: InstructionPageItem["instruction"],
): string => {
	if (instruction.paragraphs.length === 0) {
		return instruction.text.replace(/\n/g, "\n\n");
	}

	const levels = instruction.paragraphs.map(
		(paragraph) => paragraph.level ?? 0,
	);
	const baseLevel = Math.min(...levels);

	return instruction.paragraphs
		.map((paragraph) => {
			const level = Math.max(0, (paragraph.level ?? baseLevel) - baseLevel);
			const marker = level > 0 ? `${">".repeat(level)} ` : "";
			return `${marker}${paragraph.text}`;
		})
		.join("\n\n");
};

const getInstructionLocationHeader = (
	instruction: InstructionPageItem["instruction"],
	locationMarkers: string[],
): string => {
	const billSection = instruction.billSection?.trim() ?? "Instruction";
	const location =
		locationMarkers.length > 0
			? `${billSection} ${locationMarkers.join("")}:`
			: billSection;
	const citation =
		instruction.uscCitation?.replace(/U\.S\.C\./g, "USC") ?? instruction.target;
	return `${location} Edit ${citation}.`;
};

const getInstructionLocationMarkers = (
	items: AnnotationLayerProps["items"],
	instructionIndex: number,
): string[] => {
	const instructionItem = items[instructionIndex]?.item;
	if (!instructionItem || instructionItem.type !== "instruction") {
		return [];
	}

	const firstInstructionParagraph = instructionItem.instruction.paragraphs[0];
	const instructionMarkers = extractLeadingMarkers(
		firstInstructionParagraph?.text ?? "",
	);
	const firstInstructionLevel = firstInstructionParagraph?.level ?? 0;

	if (instructionMarkers.length === 0 || firstInstructionLevel <= 0) {
		return instructionMarkers;
	}

	const ancestorByLevel = new Map<number, string>();
	for (let i = instructionIndex - 1; i >= 0; i--) {
		const item = items[i]?.item;
		if (!item || item.type !== "paragraph" || item.level === null) continue;
		if (item.level < 0 || item.level >= firstInstructionLevel) continue;
		if (ancestorByLevel.has(item.level)) continue;
		const marker = extractLeadingMarkers(item.text)[0];
		if (!marker) continue;
		ancestorByLevel.set(item.level, marker);
		if (ancestorByLevel.size === firstInstructionLevel) break;
	}

	const ancestorMarkers: string[] = [];
	for (let level = 0; level < firstInstructionLevel; level++) {
		const marker = ancestorByLevel.get(level);
		if (marker) {
			ancestorMarkers.push(marker);
		}
	}

	const instructionMarkerPath = ancestorMarkers.concat(instructionMarkers);
	return instructionMarkerPath.length > 0
		? instructionMarkerPath
		: instructionMarkers;
};

export function AnnotationLayer(props: AnnotationLayerProps) {
	let containerRef!: HTMLDivElement;

	// The layout engine
	createEffect(() => {
		const items = props.items; // Dependency tracking
		const container = containerRef;
		if (!container) return;

		// We need to wait for the DOM to be updated with the new items
		// requestAnimationFrame is usually enough, or queueMicrotask if we want it sooner.
		// Since we're measuring DOM elements, we need them to be rendered.
		requestAnimationFrame(() => {
			const itemElements = Array.from(container.children) as HTMLDivElement[];

			if (itemElements.length === 0) return;

			// Sort elements by their data-ideal-top to ensure we process in order
			// (The props.items should already be sorted, but DOM order might vary if we're not careful,
			// though SolidJS rendering usually preserves order. We'll trust index matching for now for speed,
			// or we can attach data attributes).
			// Actually, let's rely on the fact that we render <For> in order.

			let currentY = -Infinity;

			itemElements.forEach((el, index) => {
				const itemData = items[index];
				if (!itemData) return;

				const idealTop = itemData.globalTop;
				const height = el.getBoundingClientRect().height;

				// If this is a new "section" (far away from previous), reset currentY?
				// Actually, the requirement is "max(ideal, previous + gap)".
				// So if ideal > currentY, we jump to ideal.

				let top = idealTop;
				if (top < currentY + ITEM_GAP) {
					top = currentY + ITEM_GAP;
				}

				el.style.top = `${top}px`;

				// Update currentY for next item
				currentY = top + height;
			});
		});
	});

	return (
		<div
			ref={containerRef}
			style={{
				position: "relative",
				height: `${props.totalHeight}px`,
				width: "100%",
				"pointer-events": "none", // Allow clicking through to empty space if needed, though items should have pointer-events: auto
			}}
		>
			<For each={props.items}>
				{(entry, index) => (
					<div
						style={{
							position: "absolute",
							left: "0",
							top: `${entry.globalTop}px`, // Initial position before layout effect
							width: "100%",
							"pointer-events": "auto",
							transition: "top 0.1s ease-out", // Smooth snapping, optional
						}}
					>
						<Show
							when={entry.item.type === "instruction"}
							fallback={
								<p
									class={
										entry.item.type === "paragraph" &&
										entry.item.colorIndex !== null
											? `pdf-amend-color-${entry.item.colorIndex}`
											: undefined
									}
									style={
										entry.item.type === "paragraph" && entry.item.isBold
											? { "font-weight": 700 }
											: undefined
									}
								>
									{entry.item.type === "paragraph" ? entry.item.text : ""}
								</p>
							}
						>
							{(() => {
								const instructionItem = entry.item as Extract<
									PageItem,
									{ type: "instruction" }
								>;
								const locationMarkers = getInstructionLocationMarkers(
									props.items,
									index(),
								);
								return (
									<button
										type="button"
										class="pdf-instruction-button"
										onClick={() => props.onInstructionClick(instructionItem)}
									>
										{instructionItem.amendmentEffect?.status === "ok" ? (
											<div
												class={`pdf-amend-color-${instructionItem.colorIndex}`}
											>
												<AmendedSnippet
													effect={instructionItem.amendmentEffect}
													instructionHeader={getInstructionLocationHeader(
														instructionItem.instruction,
														locationMarkers,
													)}
													instructionMarkdown={renderInstructionMarkdown(
														instructionItem.instruction,
													)}
												/>
											</div>
										) : (
											<div
												class={`pdf-amend-color-${instructionItem.colorIndex}`}
											>
												<header class="pdf-amended-snippet-header">
													<h4>
														{getInstructionLocationHeader(
															instructionItem.instruction,
															locationMarkers,
														)}
													</h4>
												</header>
												<div
													class="pdf-amended-snippet-instruction markdown"
													innerHTML={renderMarkdown(
														renderInstructionMarkdown(
															instructionItem.instruction,
														),
													)}
												/>
											</div>
										)}
									</button>
								);
							})()}
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}
