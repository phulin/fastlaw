import type { PDFDocumentProxy } from "pdfjs-dist";
import { createSignal, For, onMount } from "solid-js";

interface PageRowProps {
	pageNumber: number;
	paragraphs: string[];
	pdf: PDFDocumentProxy;
	pdfjsLib: Awaited<typeof import("pdfjs-dist")>;
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

	const renderPage = async () => {
		try {
			if (!props.isCurrentRun(props.runId)) return;
			const page = await props.pdf.getPage(props.pageNumber);
			if (!props.isCurrentRun(props.runId)) return;

			// Standard Letter size at 1.5 scale is roughly just right for reading
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

			const renderContext = {
				canvasContext: context,
				viewport,
			};

			// @ts-expect-error - PDF.js types mismatch
			const renderTask = page.render(renderContext);
			const textContentSource = page.streamTextContent();
			const textLayer = new props.pdfjsLib.TextLayer({
				textContentSource,
				container: textLayerDiv,
				viewport: textLayerViewport,
			});
			await Promise.all([textLayer.render(), renderTask.promise]);
			if (!props.isCurrentRun(props.runId)) return;
			props.onRenderSuccess(props.pageNumber, props.runId);
		} catch (error: unknown) {
			if (!props.isCurrentRun(props.runId)) return;
			props.onRenderError(error, props.runId);
		}
	};

	onMount(() => {
		void renderPage();
	});

	return (
		<div
			data-page-number={props.pageNumber}
			style={{
				display: "grid",
				"grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr)",
				"min-height": "100vh",
				"border-bottom": "1px solid rgba(20, 18, 16, 0.14)",
				width: "100%",
			}}
		>
			<div
				style={{
					display: "flex",
					"flex-direction": "column",
					"align-items": "center",
					padding: "2rem",
					"border-right": "1px solid rgba(20, 18, 16, 0.14)",
					"background-color": "#f6f3ee",
				}}
			>
				<div
					style={{
						position: "relative",
						"box-shadow": "0 4px 12px rgba(0,0,0,0.15)",
						"background-color": "white",
						width: pageWidth() === null ? "auto" : `${pageWidth()}px`,
						height: pageHeight() === null ? "auto" : `${pageHeight()}px`,
					}}
				>
					<canvas
						ref={canvas}
						style={{
							width: "100%",
							height: "100%",
							display: "block",
						}}
					/>
					<div
						ref={textLayerDiv}
						class="textLayer"
						style={{
							width: "100%",
							height: "100%",
							position: "absolute",
							left: "0",
							top: "0",
							"--scale-factor": String(textLayerScale()),
							"--total-scale-factor": String(textLayerScale()),
						}}
					/>
				</div>
			</div>

			<div
				style={{
					padding: "2rem",
					"background-color": "white",
					"font-family": "monospace",
					"font-size": "0.75rem",
					"white-space": "pre-wrap",
					overflow: "auto",
					width: "100%",
					"min-width": "0",
				}}
			>
				<For each={props.paragraphs}>{(paragraph) => <p>{paragraph}</p>}</For>
			</div>
		</div>
	);
}
