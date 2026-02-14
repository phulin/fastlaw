import { createEffect, For, onCleanup, onMount, Show } from "solid-js";
import type { PageItem } from "./PageRow";

export interface PageLayout {
	pageOffset: number;
	pageHeight: number;
	pageWidth: number;
}

interface AnnotationLayerProps {
	items: { item: PageItem; globalTop: number; pageNumber: number }[];
	totalHeight: number;
	width: number; // The width of the annotation column
}

const SECTION_GAP = 16;
const ITEM_GAP = 0;

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
				{(entry) => (
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
								>
									{entry.item.type === "paragraph" ? entry.item.text : ""}
								</p>
							}
						>
							<p
								class={`pdf-amend-color-${
									(entry.item as Extract<PageItem, { type: "instruction" }>)
										.colorIndex
								}`}
							>
								{
									(entry.item as Extract<PageItem, { type: "instruction" }>)
										.instruction.text
								}
							</p>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}
