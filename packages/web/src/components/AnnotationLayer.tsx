import { createEffect, createMemo, For, Show } from "solid-js";
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
const DEFAULT_MEASURED_HEIGHT = 28;
const LEADING_MARKER_RE = /^\(([^)]+)\)/;
const SECTION_HEADING_RE = /^SEC\.\s+\d+/;
const BILL_SECTION_NUMBER_RE = /^SEC\.\s+([0-9A-Za-z-]+)/i;

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
	const billSectionNumber =
		billSection.match(BILL_SECTION_NUMBER_RE)?.[1] ?? null;
	const billSectionLabel = billSectionNumber ?? billSection;
	const location =
		locationMarkers.length > 0
			? `${billSectionLabel}${locationMarkers.join("")}:`
			: "";
	const citation =
		instruction.uscCitation?.replace(/U\.S\.C\./g, "USC") ?? instruction.target;
	return location ? `${location} Edit ${citation}.` : `Edit ${citation}.`;
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
	const measuredHeights = new Map<string, number>();

	const toHeightCacheKey = (entry: AnnotationLayerProps["items"][number]) => {
		const top = entry.item.topPercent.toFixed(4);
		if (entry.item.type === "paragraph") {
			return `p:${entry.pageNumber}:${top}:${entry.item.text}`;
		}
		return `i:${entry.pageNumber}:${top}:${entry.item.instruction.targetScopePath}:${entry.item.instruction.text}`;
	};

	const computeTopPositions = (
		items: AnnotationLayerProps["items"],
		getHeight: (entry: AnnotationLayerProps["items"][number]) => number,
	) => {
		const tops: number[] = [];
		let currentY = -Infinity;

		for (const entry of items) {
			let top = entry.globalTop;
			if (top < currentY + ITEM_GAP) {
				top = currentY + ITEM_GAP;
			}
			tops.push(top);
			currentY = top + getHeight(entry);
		}

		return tops;
	};

	const cachedTopPositions = createMemo(() =>
		computeTopPositions(
			props.items,
			(entry) =>
				measuredHeights.get(toHeightCacheKey(entry)) ?? DEFAULT_MEASURED_HEIGHT,
		),
	);

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

			itemElements.forEach((el, index) => {
				const itemData = items[index];
				if (!itemData) return;
				measuredHeights.set(
					toHeightCacheKey(itemData),
					el.getBoundingClientRect().height,
				);
			});

			const measuredTops = computeTopPositions(
				items,
				(entry) =>
					measuredHeights.get(toHeightCacheKey(entry)) ??
					DEFAULT_MEASURED_HEIGHT,
			);

			itemElements.forEach((el, index) => {
				const top = measuredTops[index];
				if (top !== undefined) {
					el.style.top = `${top}px`;
				}
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
						data-key={toHeightCacheKey(entry)}
						style={{
							position: "absolute",
							left: "0",
							top: `${cachedTopPositions()[index()] ?? entry.globalTop}px`,
							width: "100%",
							"pointer-events": "auto",
							transition: "top 0.1s ease-out", // Smooth snapping, optional
						}}
					>
						<Show
							when={entry.item.type === "instruction"}
							fallback={
								entry.item.type === "paragraph" &&
								entry.item.colorIndex === null &&
								SECTION_HEADING_RE.test(entry.item.text) ? (
									<h4
										style={
											entry.item.isBold ? { "font-weight": 700 } : undefined
										}
									>
										{entry.item.text}
									</h4>
								) : (
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
								)
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
												/>
											</div>
										) : (
											<div
												class={`pdf-amend-color-${instructionItem.colorIndex}`}
											>
												<div class="pdf-amended-snippet">
													<header class="pdf-amended-snippet-header">
														<h4>
															{getInstructionLocationHeader(
																instructionItem.instruction,
																locationMarkers,
															)}
														</h4>
														<span class="pdf-amended-snippet-status-badge">
															Application failed
														</span>
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
