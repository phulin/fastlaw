import { MetaProvider, Title } from "@solidjs/meta";
// Import types from pdfjs-dist
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createSignal, For, onMount, Show } from "solid-js";
import { Header } from "./components/Header";
import { PageRow } from "./components/PageRow";
import "pdfjs-dist/web/pdf_viewer.css";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { PdfParagraphExtractor } from "./lib/text-extract";

const HASH_PREFIX_LENGTH = 8;
const INITIAL_RENDER_PAGE_COUNT = 5;

const normalizeHashKey = (hash: string) => hash.slice(0, HASH_PREFIX_LENGTH);

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
	return normalizeHashKey(
		hashArray.map((b) => b.toString(16).padStart(2, "0")).join(""),
	);
};

export default function PdfApp() {
	interface PageRowState {
		pageNumber: number;
		paragraphs: string[];
	}

	const [_file, setFile] = createSignal<File | null>(null);
	const [pageRows, setPageRows] = createSignal<PageRowState[]>([]);
	const [activeRunId, setActiveRunId] = createSignal(0);
	const [_renderedInitialPageCount, setRenderedInitialPageCount] =
		createSignal(0);
	const [renderContext, setRenderContext] = createSignal<{
		pdf: PDFDocumentProxy;
		pdfjsLib: Awaited<typeof import("pdfjs-dist")>;
	} | null>(null);
	const [status, setStatus] = createSignal<
		"idle" | "processing" | "rendering" | "rendered" | "error"
	>("idle");
	const [error, setError] = createSignal<string | null>(null);
	const [fileName, setFileName] = createSignal<string>("");

	// Refs and state for PDF rendering
	let canvasContainer: HTMLDivElement | undefined;
	let fileInput: HTMLInputElement | undefined;
	let scrollContainer: HTMLDivElement | undefined;
	let currentPdf: PDFDocumentProxy | null = null;
	let pdfjsLib: Awaited<typeof import("pdfjs-dist")> | null = null;
	let currentFileHash: string | null = null;
	let currentRunId = 0;
	let initialScrollTargetPage = 1;
	let hasAppliedInitialScroll = false;

	const reset = (keepHash = false) => {
		setFile(null);
		setPageRows([]);
		setActiveRunId(0);
		setRenderedInitialPageCount(0);
		setRenderContext(null);
		setStatus("idle");
		setError(null);
		setFileName("");
		if (fileInput) fileInput.value = "";
		currentPdf = null;
		scrollContainer = undefined;
		currentFileHash = null;
		initialScrollTargetPage = 1;
		hasAppliedInitialScroll = false;
		currentRunId += 1;
		// Clear hash when resetting, unless requested to keep it (e.g. during initial load)
		if (!keepHash && typeof window !== "undefined") {
			history.pushState(
				"",
				document.title,
				window.location.pathname + window.location.search,
			);
		}
	};

	const parseHashState = () => {
		const raw = window.location.hash.slice(1);
		if (!raw) return null;

		const params = new URLSearchParams(raw);
		const hash = normalizeHashKey(params.get("hash") ?? raw);
		if (!hash) return null;

		const parsedPage = Number(params.get("page") ?? "1");
		const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
		return { hash, page };
	};

	const replaceLocationHash = (page: number) => {
		if (!currentFileHash || typeof window === "undefined") return;
		const params = new URLSearchParams();
		params.set("page", String(page));
		params.set("hash", currentFileHash);
		history.replaceState(
			"",
			document.title,
			`${window.location.pathname}${window.location.search}#${params.toString()}`,
		);
	};

	const scrollToPage = (page: number) => {
		if (!scrollContainer || !canvasContainer) return;
		const target = canvasContainer.querySelector<HTMLElement>(
			`[data-page-number="${page}"]`,
		);
		if (!target) return;
		scrollContainer.scrollTo({ top: Math.max(0, target.offsetTop - 80) });
	};

	onMount(async () => {
		if (typeof window === "undefined" || !window.location.hash) return;
		const parsed = parseHashState();
		if (!parsed) return;
		const file = await getFileFromDB(parsed.hash);
		if (!file) return;
		// Load file without persisting again and restore target page.
		processFile(file, false, parsed.hash, parsed.page);
	});

	const appendParagraphs = (
		pageNumber: number,
		paragraphs: { text: string }[],
	) => {
		if (paragraphs.length === 0) return;
		setPageRows((previousRows) =>
			previousRows.map((row) =>
				row.pageNumber === pageNumber
					? {
							...row,
							paragraphs: [...row.paragraphs, ...paragraphs.map((p) => p.text)],
						}
					: row,
			),
		);
	};

	const setupPageRows = () => {
		if (!currentPdf) return;
		setPageRows(
			Array.from({ length: currentPdf.numPages }, (_, index) => ({
				pageNumber: index + 1,
				paragraphs: [],
			})),
		);
	};

	const startTextExtraction = async (
		pdf: PDFDocumentProxy,
		runId: number,
	): Promise<void> => {
		const extractor = new PdfParagraphExtractor();
		try {
			for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
				if (runId !== currentRunId) return;
				const page = await pdf.getPage(pageNum);
				const textContent = await page.getTextContent();
				extractor.ingestPage(pageNum, textContent.items as TextItem[]);
				appendParagraphs(pageNum, extractor.drainClosedParagraphs());
			}
			appendParagraphs(pdf.numPages, extractor.finish());
		} catch (err: unknown) {
			if (runId !== currentRunId) return;
			console.error("Error extracting text:", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		}
	};

	const handlePageRenderSuccess = (pageNumber: number, runId: number) => {
		if (runId !== currentRunId || !currentPdf) return;
		if (!hasAppliedInitialScroll && pageNumber === initialScrollTargetPage) {
			scrollToPage(pageNumber);
			replaceLocationHash(pageNumber);
			hasAppliedInitialScroll = true;
		}

		const pagesToRender = Math.min(
			INITIAL_RENDER_PAGE_COUNT,
			currentPdf.numPages,
		);
		setRenderedInitialPageCount((count) => {
			const nextCount = count + 1;
			if (nextCount >= pagesToRender) setStatus("rendered");
			return nextCount;
		});
	};

	const handlePageRenderError = (err: unknown, runId: number) => {
		if (runId !== currentRunId) return;
		console.error("Error rendering page:", err);
		setError(err instanceof Error ? err.message : String(err));
		setStatus("error");
	};

	const processFile = async (
		selectedFile: File,
		shouldPersist = true,
		existingHash?: string,
		initialPage = 1,
	) => {
		reset(true); // clear previous state logic, but keep hash initially

		setFile(selectedFile);
		setFileName(selectedFile.name);
		setStatus("processing");

		try {
			if (shouldPersist) {
				const hash = await hashFile(selectedFile);
				await saveFileToDB(hash, selectedFile);
				currentFileHash = hash;
			} else if (existingHash) {
				currentFileHash = normalizeHashKey(existingHash);
			}
			replaceLocationHash(1);

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
			setRenderContext({ pdf: currentPdf, pdfjsLib });
			const runId = currentRunId;
			const targetPage = Math.min(
				Math.max(1, Math.floor(initialPage)),
				currentPdf.numPages,
			);
			const renderedTargetPage = Math.min(
				targetPage,
				Math.min(INITIAL_RENDER_PAGE_COUNT, currentPdf.numPages),
			);

			setRenderedInitialPageCount(0);
			setActiveRunId(runId);
			initialScrollTargetPage = renderedTargetPage;
			hasAppliedInitialScroll = false;
			setupPageRows();
			void startTextExtraction(currentPdf, runId);
			setStatus("rendering");
		} catch (err: unknown) {
			console.error(err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		}
	};

	// Separate ref handlers for the load-more trigger wiring
	const scrollContainerRef = (el: HTMLDivElement) => {
		scrollContainer = el;
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

							<div ref={canvasContainer} class="flex flex-col w-full">
								<Show when={renderContext()}>
									{(ctx) => (
										<For each={pageRows().slice(0, INITIAL_RENDER_PAGE_COUNT)}>
											{(pageRow) => (
												<PageRow
													pageNumber={pageRow.pageNumber}
													paragraphs={pageRow.paragraphs}
													pdf={ctx().pdf}
													pdfjsLib={ctx().pdfjsLib}
													runId={activeRunId()}
													isCurrentRun={(runId) => runId === currentRunId}
													onRenderSuccess={handlePageRenderSuccess}
													onRenderError={handlePageRenderError}
												/>
											)}
										</For>
									)}
								</Show>
							</div>
						</div>
					</Show>
				</main>
			</div>
		</MetaProvider>
	);
}
