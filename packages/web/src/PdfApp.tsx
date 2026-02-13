import { MetaProvider, Title } from "@solidjs/meta";
// Import types from pdfjs-dist
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Header } from "./components/Header";
import "pdfjs-dist/web/pdf_viewer.css";

const BATCH_SIZE = 5;
const SCROLL_THRESHOLD = 200; // pixels from bottom to trigger next batch

// Persistence Helpers
const openDB = () => {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("PdfViewerDB", 1);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains("files")) {
				db.createObjectStore("files");
			}
		};
	});
};

const saveFileToDB = async (hash: string, file: File) => {
	try {
		const db = await openDB();
		return new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("files", "readwrite");
			const store = transaction.objectStore("files");
			const request = store.put(file, hash);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	} catch (e) {
		console.error("Failed to save to DB", e);
	}
};

const getFileFromDB = async (hash: string): Promise<File | undefined> => {
	try {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction("files", "readonly");
			const store = transaction.objectStore("files");
			const request = store.get(hash);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		});
	} catch (e) {
		console.error("Failed to get from DB", e);
		return undefined;
	}
};

const hashFile = async (file: File): Promise<string> => {
	const buffer = await file.arrayBuffer();
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
};

export default function PdfApp() {
	const [_file, setFile] = createSignal<File | null>(null);
	const [status, setStatus] = createSignal<
		"idle" | "processing" | "rendering" | "rendered" | "error"
	>("idle");
	const [error, setError] = createSignal<string | null>(null);
	const [fileName, setFileName] = createSignal<string>("");

	// Refs and state for PDF rendering
	let canvasContainer: HTMLDivElement | undefined;
	let fileInput: HTMLInputElement | undefined;
	let currentPdf: PDFDocumentProxy | null = null;
	let pdfjsLib: Awaited<typeof import("pdfjs-dist")> | null = null;
	let cleanupObserver: (() => void) | null = null;
	let nextPageToRender = 1;
	let isRenderingBatch = false;

	const extractParagraphsFromTextLayer = (textLayerDiv: HTMLDivElement) => {
		const spans = Array.from(textLayerDiv.querySelectorAll("span"));
		const paragraphs: string[] = [];
		let previousTop: number | null = null;
		let currentLine: string[] = [];

		for (const span of spans) {
			const text = span.textContent?.trim();
			if (!text) continue;

			const top = Number.parseFloat(span.style.top || "0");
			if (previousTop !== null && Math.abs(top - previousTop) > 0.5) {
				const paragraph = currentLine.join(" ").trim();
				if (paragraph) paragraphs.push(paragraph);
				currentLine = [];
			}

			currentLine.push(text);
			previousTop = top;
		}

		const paragraph = currentLine.join(" ").trim();
		if (paragraph) paragraphs.push(paragraph);

		return paragraphs;
	};

	const reset = (keepHash = false) => {
		setFile(null);
		setStatus("idle");
		setError(null);
		setFileName("");
		if (fileInput) fileInput.value = "";
		if (canvasContainer) canvasContainer.innerHTML = "";
		currentPdf = null;
		nextPageToRender = 1;
		isRenderingBatch = false;
		if (cleanupObserver) {
			cleanupObserver();
			cleanupObserver = null;
		}
		// Clear hash when resetting, unless requested to keep it (e.g. during initial load)
		if (!keepHash && typeof window !== "undefined") {
			history.pushState(
				"",
				document.title,
				window.location.pathname + window.location.search,
			);
		}
	};

	onCleanup(() => {
		if (cleanupObserver) cleanupObserver();
	});

	onMount(async () => {
		if (typeof window !== "undefined" && window.location.hash) {
			const hash = window.location.hash.slice(1); // remove #
			if (hash) {
				const file = await getFileFromDB(hash);
				if (file) {
					// Load file without persisting again
					processFile(file, false);
				}
			}
		}
	});

	const renderNextBatch = async () => {
		if (
			!currentPdf ||
			isRenderingBatch ||
			nextPageToRender > currentPdf.numPages
		)
			return;

		isRenderingBatch = true;
		setStatus("rendering");

		try {
			const endPage = Math.min(
				nextPageToRender + BATCH_SIZE - 1,
				currentPdf.numPages,
			);

			for (let pageNum = nextPageToRender; pageNum <= endPage; pageNum++) {
				const page = await currentPdf.getPage(pageNum);
				// Standard Letter size at 1.5 scale is roughly just right for reading
				const pixelRatio = window.devicePixelRatio || 1;
				const baseScale = 1.3;
				const viewport = page.getViewport({ scale: baseScale * pixelRatio });
				const textLayerViewport = page.getViewport({ scale: baseScale });

				// Create a row for the page (PDF left, Text right)
				const pageRow = document.createElement("div");
				pageRow.className =
					"grid grid-cols-2 min-h-screen border-b border-gray-200 last:border-0";
				pageRow.style.width = "100%";

				// --- Left Column: PDF ---
				const pdfContainer = document.createElement("div");
				pdfContainer.className =
					"flex flex-col items-center bg-gray-100 p-8 border-r border-gray-200";

				const wrapper = document.createElement("div");
				wrapper.style.position = "relative";
				wrapper.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
				// Match the visual size (logical pixels)
				wrapper.style.width = `${textLayerViewport.width}px`;
				wrapper.style.height = `${textLayerViewport.height}px`;
				wrapper.style.backgroundColor = "white";

				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");

				if (context && canvasContainer && pdfjsLib) {
					canvas.height = viewport.height;
					canvas.width = viewport.width;
					// Responsive styling
					canvas.style.width = "100%";
					canvas.style.height = "100%";
					canvas.style.display = "block";

					wrapper.appendChild(canvas);

					const textLayerDiv = document.createElement("div");
					textLayerDiv.className = "textLayer";
					textLayerDiv.style.width = "100%";
					textLayerDiv.style.height = "100%";
					textLayerDiv.style.position = "absolute";
					textLayerDiv.style.left = "0";
					textLayerDiv.style.top = "0";
					// Define CSS variable for text layer scaling if needed by recent pdf.js versions
					textLayerDiv.style.setProperty("--scale-factor", String(baseScale));
					textLayerDiv.style.setProperty(
						"--total-scale-factor",
						String(baseScale),
					);

					wrapper.appendChild(textLayerDiv);
					pdfContainer.appendChild(wrapper);
					pageRow.appendChild(pdfContainer);

					const textPanel = document.createElement("div");
					textPanel.className =
						"p-8 bg-white font-mono text-xs whitespace-pre-wrap overflow-auto";

					pageRow.appendChild(textPanel);

					// Append the row to the main container
					canvasContainer.appendChild(pageRow);

					const renderContext = {
						canvasContext: context,
						viewport: viewport,
					};

					// @ts-expect-error - PDF.js types mismatch
					const renderTask = page.render(renderContext);

					// @ts-expect-error - PDF.js types mismatch
					const textContentSource = page.streamTextContent();

					// @ts-expect-error - PDF.js types mismatch
					const textLayer = new pdfjsLib.TextLayer({
						textContentSource,
						container: textLayerDiv,
						viewport: textLayerViewport,
					});
					await Promise.all([textLayer.render(), renderTask.promise]);

					const paragraphs = extractParagraphsFromTextLayer(textLayerDiv);
					for (const paragraph of paragraphs) {
						const p = document.createElement("p");
						p.append(document.createTextNode(paragraph));
						textPanel.appendChild(p);
					}
				}
			}

			nextPageToRender = endPage + 1;

			if (nextPageToRender > currentPdf.numPages) {
				setStatus("rendered");
			} else {
				setStatus("rendered");
			}
		} catch (err: unknown) {
			console.error("Error rendering batch:", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		} finally {
			isRenderingBatch = false;
		}
	};

	const setupScrollObserver = (element: HTMLElement) => {
		const handleScroll = () => {
			const { scrollTop, scrollHeight, clientHeight } = element;
			if (scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD) {
				renderNextBatch();
			}
		};

		element.addEventListener("scroll", handleScroll);
		return () => element.removeEventListener("scroll", handleScroll);
	};

	const processFile = async (selectedFile: File, shouldPersist = true) => {
		reset(true); // clear previous state logic, but keep hash initially

		setFile(selectedFile);
		setFileName(selectedFile.name);
		setStatus("processing");

		try {
			if (shouldPersist) {
				const hash = await hashFile(selectedFile);
				await saveFileToDB(hash, selectedFile);
				window.location.hash = hash;
			}

			// Dynamic import
			pdfjsLib = await import("pdfjs-dist");
			// @ts-expect-error - PDF.js types mismatch
			await import("pdfjs-dist/build/pdf.worker.mjs");

			if (
				typeof window !== "undefined" &&
				!pdfjsLib.GlobalWorkerOptions.workerSrc
			) {
				pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
					"pdfjs-dist/build/pdf.worker.mjs",
					import.meta.url,
				).toString();
			}

			const arrayBuffer = await selectedFile.arrayBuffer();
			const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
			currentPdf = await loadingTask.promise;

			// Initial render
			await renderNextBatch(); // Renders first batch
		} catch (err: unknown) {
			console.error(err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		}
	};

	// Separate ref handler for the scroll container to attach listener
	const scrollContainerRef = (el: HTMLDivElement) => {
		// When element is mounted/created
		cleanupObserver = setupScrollObserver(el);
	};

	const handleDrop = (e: DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer?.files[0]) {
			processFile(e.dataTransfer.files[0], true);
		}
	};

	const handleDragOver = (e: DragEvent) => {
		e.preventDefault();
	};

	return (
		<MetaProvider>
			<Title>PDF Viewer - fast.law</Title>
			<div class="flex min-h-screen flex-col">
				<Header />

				<main
					class={`min-h-0 flex-1 flex flex-col ${status() === "idle" ? "items-center justify-center p-8" : "w-full overflow-hidden"}`}
				>
					<Show when={status() === "idle"}>
						<section
							class="border-2 border-dashed border-[var(--line)] rounded-xl p-12 text-center bg-white transition-all cursor-pointer w-full max-w-[600px] hover:border-[var(--accent)] hover:bg-[rgba(217,119,87,0.05)]"
							onDragOver={handleDragOver}
							onDrop={handleDrop}
							onClick={() => fileInput?.click()}
							onKeyPress={(e) => {
								if (e.key === "Enter" || e.key === " ") fileInput?.click();
							}}
							aria-label="PDF drop zone"
							tabindex="0"
						>
							<h1 class="font-serif m-0 mb-4">Upload PDF</h1>
							<p>Drag and drop a PDF file here, or click to select</p>
							<input
								type="file"
								accept="application/pdf"
								class="hidden"
								ref={fileInput}
								onChange={(e) => {
									if (e.target.files?.[0]) processFile(e.target.files[0], true);
								}}
							/>
							<button
								type="button"
								class="bg-[var(--accent)] text-white border-none px-6 py-3 rounded-md font-medium cursor-pointer mt-4 hover:opacity-90"
							>
								Select File
							</button>
						</section>
					</Show>

					<Show when={status() !== "idle"}>
						{/* Scroll container */}
						<div
							ref={scrollContainerRef}
							class="w-full min-h-0 flex-1 bg-white overflow-y-auto overflow-x-hidden block relative"
						>
							<div class="flex justify-between items-center px-8 py-4 sticky top-0 bg-white z-20 border-b border-[var(--line)] shadow-sm">
								<h2 class="m-0 text-ellipsis overflow-hidden whitespace-nowrap max-w-[70%] text-lg font-medium">
									{fileName()}
								</h2>
								<button
									type="button"
									onClick={() => reset(false)}
									class="m-0 bg-transparent text-[var(--ink-soft)] border border-[var(--line)] px-4 py-2 rounded cursor-pointer hover:bg-gray-50"
								>
									Upload Another
								</button>
							</div>

							<Show when={status() === "processing"}>
								<p>Processing...</p>
							</Show>

							<Show when={error()}>
								<p class="text-red-500">Error processing PDF: {error()}</p>
							</Show>

							<div
								ref={canvasContainer}
								class="flex flex-col gap-5 items-center"
							/>

							<Show when={status() === "rendering"}>
								<p class="text-center text-gray-500 py-4">
									Loading more pages...
								</p>
							</Show>
						</div>
					</Show>
				</main>
			</div>
		</MetaProvider>
	);
}
