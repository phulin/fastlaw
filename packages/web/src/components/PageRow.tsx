import type { PDFDocumentProxy } from "pdfjs-dist";
import { createEffect, createSignal, For, onCleanup } from "solid-js";

interface PageRowProps {
	pageNumber: number;
	paragraphs: string[];
	pdf?: PDFDocumentProxy;
	pdfjsLib?: Awaited<typeof import("pdfjs-dist")>;
	runId: number;
	isCurrentRun: (runId: number) => boolean;
	onRenderSuccess: (pageNumber: number, runId: number) => void;
	onRenderError: (error: unknown, runId: number) => void;
}

export function PageRow(props: PageRowProps) {
	let canvas!: HTMLCanvasElement;
	let textLayerDiv!: HTMLDivElement;
	const [pageWidth, setPageWidth] = createSignal<number | null>(null);
	const [pageHeight, setPageHeight] = createSignal<number | null>(null);
	const [textLayerScale, setTextLayerScale] = createSignal(1);

	createEffect(() => {
		const pageNumber = props.pageNumber;
		const runId = props.runId;
		let isCancelled = false;
		let renderTask: {
			cancel: () => void;
			promise: Promise<unknown>;
		} | null = null;

		const renderPage = async () => {
			try {
				if (
					!props.isCurrentRun(runId) ||
					!props.pdf ||
					!canvas ||
					!textLayerDiv
				)
					return;
				const page = await props.pdf.getPage(pageNumber);
				if (!props.isCurrentRun(runId) || isCancelled) return;

				const pixelRatio = window.devicePixelRatio || 1;
				const baseScale = 1.3;
				const viewport = page.getViewport({ scale: baseScale * pixelRatio });
				const textLayerViewport = page.getViewport({ scale: baseScale });
				const context = canvas.getContext("2d");
				if (!context) return;

				setPageWidth(textLayerViewport.width);
				setPageHeight(textLayerViewport.height);
				setTextLayerScale(baseScale);

				canvas.height = viewport.height;
				canvas.width = viewport.width;
				textLayerDiv.replaceChildren();

				// @ts-expect-error - PDF.js types mismatch
				renderTask = page.render({ canvasContext: context, viewport });
				const renderPromise = renderTask.promise;
				if (props.pdfjsLib) {
					const textLayer = new props.pdfjsLib.TextLayer({
						textContentSource: page.streamTextContent(),
						container: textLayerDiv,
						viewport: textLayerViewport,
					});
					await Promise.all([renderPromise, textLayer.render()]);
				} else {
					await renderPromise;
				}
				if (!props.isCurrentRun(runId) || isCancelled) return;
				props.onRenderSuccess(pageNumber, runId);
			} catch (error: unknown) {
				if (
					error instanceof Error &&
					(error.name === "RenderingCancelledException" ||
						error.message.includes("Rendering cancelled"))
				) {
					return;
				}
				if (!props.isCurrentRun(runId) || isCancelled) return;
				props.onRenderError(error, runId);
			}
		};

		void renderPage();

		onCleanup(() => {
			isCancelled = true;
			renderTask?.cancel();
		});
	});

	return (
		<div data-page-number={props.pageNumber} class="pdf-page-row">
			<div class="pdf-page-row-viewer-pane">
				<div
					class="pdf-page-row-canvas-shell"
					style={{
						"--pdf-page-width":
							pageWidth() === null ? "auto" : `${pageWidth()}px`,
						"--pdf-page-height":
							pageHeight() === null ? "auto" : `${pageHeight()}px`,
					}}
				>
					<canvas ref={canvas} class="pdf-page-row-canvas" />
					<div
						ref={textLayerDiv}
						class="textLayer pdf-page-row-text-layer"
						style={{
							"--scale-factor": String(textLayerScale()),
							"--total-scale-factor": String(textLayerScale()),
						}}
					/>
				</div>
			</div>

			<div class="pdf-page-row-text-pane">
				<For each={props.paragraphs}>{(paragraph) => <p>{paragraph}</p>}</For>
			</div>
		</div>
	);
}
