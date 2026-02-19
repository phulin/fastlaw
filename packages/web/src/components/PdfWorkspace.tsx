import type { PDFDocumentProxy } from "pdfjs-dist";
import { For, Show } from "solid-js";
import { AnnotationLayer } from "./AnnotationLayer";
import type { InstructionPageItem, PageItem } from "./PageRow";
import { PageRow } from "./PageRow";
import "../styles/pdf-annotations.css";
import "../styles/pdf-virtualizer.css";

interface PdfWorkspaceProps {
	status: "idle" | "processing" | "rendering" | "rendered" | "error";
	isVirtualDebugEnabled: boolean;
	pageRowCount: number;
	virtualRangeLabel: string;
	virtualIndexes: number[];
	virtualStarts: number[];
	virtualSizes: number[];
	defaultItemSize: number;
	lastScrollTop: number;
	lastViewportHeight: number;
	totalSize: number;
	renderContext: {
		pdf: PDFDocumentProxy;
		pdfjsLib: Awaited<typeof import("pdfjs-dist")>;
	} | null;
	visibleItems: { item: PageItem; globalTop: number; pageNumber: number }[];
	onScrollContainerRef: (element: HTMLDivElement) => void;
	onScroll: () => void;
	onPageRenderSuccess: (pageNumber: number) => void;
	onPageRenderError: (error: unknown) => void;
	onInstructionClick: (instructionItem: InstructionPageItem) => void;
}

export function PdfWorkspace(props: PdfWorkspaceProps) {
	return (
		<div
			ref={props.onScrollContainerRef}
			class="pdf-scroll-container"
			onScroll={props.onScroll}
			style={{
				display: props.status !== "idle" ? "grid" : "none",
				"grid-template-columns": "1fr 1fr",
			}}
		>
			<Show when={props.isVirtualDebugEnabled}>
				<output class="pdf-virtualizer-debug">
					<span>count: {props.pageRowCount}</span>
					<span>range: {props.virtualRangeLabel}</span>
					<span>rendered: {props.virtualIndexes.length}</span>
					<span>scrollTop: {Math.round(props.lastScrollTop)}</span>
					<span>viewport: {Math.round(props.lastViewportHeight)}</span>
					<span>totalSize: {Math.round(props.totalSize)}</span>
				</output>
			</Show>

			<div class="pdf-column-viewer">
				<Show when={props.status !== "idle"}>
					<div
						class="pdf-virtualizer-size"
						style={{
							height: `${props.totalSize}px`,
						}}
					>
						<For each={props.virtualIndexes}>
							{(index, listIndex) => (
								<div
									data-index={index}
									data-start={Math.round(
										props.virtualStarts[listIndex()] ??
											index * props.defaultItemSize,
									)}
									data-size={Math.round(
										props.virtualSizes[listIndex()] ?? props.defaultItemSize,
									)}
									class="pdf-virtualizer-item"
									style={{
										transform: `translateY(${
											props.virtualStarts[listIndex()] ??
											index * props.defaultItemSize
										}px)`,
									}}
								>
									<Show when={props.isVirtualDebugEnabled}>
										<div class="pdf-virtualizer-item-debug">
											#{index + 1} y=
											{Math.round(
												props.virtualStarts[listIndex()] ??
													index * props.defaultItemSize,
											)}{" "}
											h=
											{Math.round(
												props.virtualSizes[listIndex()] ??
													props.defaultItemSize,
											)}
										</div>
									</Show>
									<PageRow
										pageNumber={index + 1}
										pdf={props.renderContext?.pdf}
										pdfjsLib={props.renderContext?.pdfjsLib}
										onRenderSuccess={props.onPageRenderSuccess}
										onRenderError={props.onPageRenderError}
									/>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>

			<div class="pdf-column-annotations">
				<AnnotationLayer
					items={props.visibleItems}
					totalHeight={props.totalSize}
					width={0}
					onInstructionClick={props.onInstructionClick}
				/>
			</div>
		</div>
	);
}
