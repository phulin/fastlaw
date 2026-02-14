import { MetaProvider, Title } from "@solidjs/meta";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onMount,
	Show,
} from "solid-js";
import { Header } from "./components/Header";
import { PageRow } from "./components/PageRow";
import "pdfjs-dist/web/pdf_viewer.css";
import { extractParagraphs } from "./lib/text-extract";

const HASH_PREFIX_LENGTH = 8;
const VIRTUAL_DEBUG_SEARCH_PARAM = "virtualDebug";

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
	const [renderContext, setRenderContext] = createSignal<{
		pdf: PDFDocumentProxy;
		pdfjsLib: Awaited<typeof import("pdfjs-dist")>;
	} | null>(null);
	const [status, setStatus] = createSignal<
		"idle" | "processing" | "rendering" | "rendered" | "error"
	>("idle");
	const [error, setError] = createSignal<string | null>(null);
	const [fileName, setFileName] = createSignal<string>("");
	const [scrollContainer, setScrollContainer] =
		createSignal<HTMLDivElement | null>(null);
	const [lastScrollTop, setLastScrollTop] = createSignal(0);
	const [lastViewportHeight, setLastViewportHeight] = createSignal(0);
	const [isVirtualDebugEnabled, setIsVirtualDebugEnabled] = createSignal(false);

	// Refs and state for PDF rendering
	let fileInput: HTMLInputElement | undefined;
	let currentPdf: PDFDocumentProxy | null = null;
	let pdfjsLib: Awaited<typeof import("pdfjs-dist")> | null = null;
	let currentFileHash: string | null = null;
	let initialScrollTargetPage = 1;
	let hasAppliedInitialScroll = false;

	const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		get count() {
			return pageRows().length;
		},
		getScrollElement: () => scrollContainer(),
		initialRect: {
			width: 0,
			height: typeof window === "undefined" ? 800 : window.innerHeight,
		},
		estimateSize: () => 1094,
		overscan: 2,
	});

	const virtualItems = createMemo(() => rowVirtualizer.getVirtualItems());
	const virtualRangeLabel = createMemo(() => {
		const items = virtualItems();
		if (items.length === 0) return "empty";
		return `${items[0].index}-${items[items.length - 1].index}`;
	});

	createEffect(() => {
		if (!scrollContainer() || pageRows().length === 0) return;
		pageRows();
		requestAnimationFrame(() => rowVirtualizer.measure());
	});

	let lastVirtualDebugSignature = "";
	createEffect(() => {
		if (!isVirtualDebugEnabled()) return;
		const items = virtualItems();
		const scrollTop = lastScrollTop();
		const viewportHeight = lastViewportHeight();
		const totalSize = rowVirtualizer.getTotalSize();
		const signature = JSON.stringify({
			range: virtualRangeLabel(),
			count: pageRows().length,
			totalSize,
			scrollTop,
			viewportHeight,
			starts: items
				.map((item) => `${item.index}:${Math.round(item.start)}`)
				.join(","),
		});
		if (signature === lastVirtualDebugSignature) return;
		lastVirtualDebugSignature = signature;
		console.info("[virtual-debug]", {
			count: pageRows().length,
			totalSize,
			scrollTop,
			viewportHeight,
			range: virtualRangeLabel(),
			items: items.slice(0, 8).map((item) => ({
				index: item.index,
				start: Math.round(item.start),
				size: Math.round(item.size),
				end: Math.round(item.end),
			})),
		});
	});

	const reset = (keepHash = false) => {
		setFile(null);
		setPageRows([]);
		setStatus("idle");
		setError(null);
		setFileName("");
		if (fileInput) fileInput.value = "";
		currentPdf = null;
		setScrollContainer(null);
		currentFileHash = null;
		initialScrollTargetPage = 1;
		hasAppliedInitialScroll = false;
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

	const applyInitialScroll = (page: number) => {
		const apply = () => {
			if (hasAppliedInitialScroll) return;
			if (!scrollContainer()) {
				requestAnimationFrame(apply);
				return;
			}
			rowVirtualizer.scrollToIndex(page - 1, { align: "start" });
			replaceLocationHash(page);
			hasAppliedInitialScroll = true;
		};

		requestAnimationFrame(apply);
	};

	onMount(async () => {
		if (typeof window !== "undefined") {
			const search = new URLSearchParams(window.location.search);
			setIsVirtualDebugEnabled(search.get(VIRTUAL_DEBUG_SEARCH_PARAM) === "1");
		}

		if (typeof window === "undefined" || !window.location.hash) return;
		const parsed = parseHashState();
		if (!parsed) return;
		const file = await getFileFromDB(parsed.hash);
		if (!file) return;
		// Load file without persisting again and restore target page.
		processFile(file, false, parsed.hash, parsed.page);
	});

	const setupPageRows = () => {
		if (!currentPdf) return;
		setPageRows(
			Array.from({ length: currentPdf.numPages }, (_, index) => ({
				pageNumber: index + 1,
				paragraphs: [],
			})),
		);
	};

	const handlePageRenderSuccess = (pageNumber: number) => {
		if (!currentPdf) return;
		if (!hasAppliedInitialScroll && pageNumber === initialScrollTargetPage) {
			hasAppliedInitialScroll = true;
		}
		requestAnimationFrame(() => rowVirtualizer.measure());
		if (status() === "rendering") setStatus("rendered");
	};

	const handlePageRenderError = (err: unknown) => {
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
			const targetPage = Math.min(
				Math.max(1, Math.floor(initialPage)),
				currentPdf.numPages,
			);

			initialScrollTargetPage = targetPage;
			hasAppliedInitialScroll = false;
			setStatus("rendering");
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			setupPageRows();
			void extractParagraphs(currentPdf)
				.then((paragraphsByPage) => {
					setPageRows((currentRows) =>
						currentRows.map((row, index) => ({
							...row,
							paragraphs: paragraphsByPage[index] ?? [],
						})),
					);
				})
				.catch((err: unknown) => {
					console.error("Error extracting text:", err);
					setError(err instanceof Error ? err.message : String(err));
					setStatus("error");
				});
			applyInitialScroll(targetPage);
		} catch (err: unknown) {
			console.error(err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		}
	};

	// Separate ref handlers for the load-more trigger wiring
	const scrollContainerRef = (el: HTMLDivElement) => {
		setScrollContainer(el);
		setLastScrollTop(el.scrollTop);
		setLastViewportHeight(el.clientHeight);
		rowVirtualizer.measure();
	};

	const handleScroll = () => {
		const container = scrollContainer();
		if (!container) return;
		setLastScrollTop(container.scrollTop);
		setLastViewportHeight(container.clientHeight);
		rowVirtualizer.measure();
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
			<div class="pdf-app-shell">
				<Header
					heading={status() !== "idle" ? fileName() : undefined}
					rightContent={
						status() !== "idle" ? (
							<button
								type="button"
								onClick={() => reset(false)}
								class="pdf-secondary-button"
							>
								Upload Another
							</button>
						) : undefined
					}
				/>

				<main
					class={
						status() === "idle" ? "pdf-app-main idle" : "pdf-app-main active"
					}
				>
					<Show when={status() === "idle"}>
						<section
							class="pdf-dropzone"
							onDragOver={handleDragOver}
							onDrop={handleDrop}
							onClick={() => fileInput?.click()}
							onKeyPress={(e) => {
								if (e.key === "Enter" || e.key === " ") fileInput?.click();
							}}
							aria-label="PDF drop zone"
							tabindex="0"
						>
							<h1 class="pdf-dropzone-title">Upload PDF</h1>
							<p>Drag and drop a PDF file here, or click to select</p>
							<input
								type="file"
								accept="application/pdf"
								class="pdf-file-input-hidden"
								ref={fileInput}
								onChange={(e) => {
									if (e.target.files?.[0]) processFile(e.target.files[0], true);
								}}
							/>
							<button type="button" class="pdf-primary-button">
								Select File
							</button>
						</section>
					</Show>

					<Show when={status() !== "idle"}>
						<Show when={status() === "processing"}>
							<p>Processing...</p>
						</Show>

						<Show when={error()}>
							<p class="pdf-error-text">Error processing PDF: {error()}</p>
						</Show>

						<div
							ref={scrollContainerRef}
							class="pdf-scroll-container"
							onScroll={handleScroll}
						>
							<Show when={isVirtualDebugEnabled()}>
								<output class="pdf-virtualizer-debug">
									<span>count: {pageRows().length}</span>
									<span>range: {virtualRangeLabel()}</span>
									<span>rendered: {virtualItems().length}</span>
									<span>scrollTop: {Math.round(lastScrollTop())}</span>
									<span>viewport: {Math.round(lastViewportHeight())}</span>
									<span>
										totalSize: {Math.round(rowVirtualizer.getTotalSize())}
									</span>
								</output>
							</Show>
							<div
								class="pdf-virtualizer-size"
								style={{
									height: `${rowVirtualizer.getTotalSize()}px`,
								}}
							>
								<For each={virtualItems()}>
									{(virtualItem) => (
										<div
											ref={(el) => rowVirtualizer.measureElement(el)}
											data-index={virtualItem.index}
											data-start={Math.round(virtualItem.start)}
											data-size={Math.round(virtualItem.size)}
											class="pdf-virtualizer-item"
											style={{
												transform: `translateY(${virtualItem.start}px)`,
											}}
										>
											<Show when={isVirtualDebugEnabled()}>
												<div class="pdf-virtualizer-item-debug">
													#{virtualItem.index + 1} y=
													{Math.round(virtualItem.start)} h=
													{Math.round(virtualItem.size)}
												</div>
											</Show>
											<PageRow
												pageNumber={pageRows()[virtualItem.index].pageNumber}
												paragraphs={pageRows()[virtualItem.index].paragraphs}
												pdf={renderContext()?.pdf}
												pdfjsLib={renderContext()?.pdfjsLib}
												onRenderSuccess={handlePageRenderSuccess}
												onRenderError={handlePageRenderError}
											/>
										</div>
									)}
								</For>
							</div>
						</div>
					</Show>
				</main>
			</div>
		</MetaProvider>
	);
}
