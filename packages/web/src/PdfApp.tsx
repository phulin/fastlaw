import { MetaProvider, Title } from "@solidjs/meta";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { PageLayout } from "./components/AnnotationLayer";
import { Header } from "./components/Header";
import { InstructionDebugModal } from "./components/InstructionDebugModal";
import type { InstructionPageItem, PageItem } from "./components/PageRow";
import { PdfUploadDropzone } from "./components/PdfUploadDropzone";
import { PdfWorkspace } from "./components/PdfWorkspace";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles/pdf-base.css";
import type { ProcessingWorkerResponse } from "./lib/pdf/processing-worker-types";
import type { SourceVersionRecord } from "./lib/types";

const HASH_PREFIX_LENGTH = 8;
const NUM_AMEND_COLORS = 6;
const VIRTUAL_DEBUG_SEARCH_PARAM = "virtualDebug";
const DEFAULT_ITEM_SIZE = 1078;

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

interface SourceVersionsResponse {
	versions: SourceVersionRecord[];
}

export default function PdfApp() {
	interface PageRowState {
		pageNumber: number;
		items: PageItem[];
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
	// virtualIndexes always contiguous, so we can store starts / sizes densely.
	const [virtualIndexes, setVirtualIndexes] = createSignal<number[]>([0, 1, 2]);
	const [virtualStarts, setVirtualStarts] = createSignal<number[]>(
		[0, 1, 2].map((i) => i * DEFAULT_ITEM_SIZE),
	);
	const [virtualSizes, setVirtualSizes] = createSignal<number[]>(
		[0, 1, 2].map(() => DEFAULT_ITEM_SIZE),
	);
	const [isVirtualDebugEnabled, setIsVirtualDebugEnabled] = createSignal(false);
	const [selectedInstructionItem, setSelectedInstructionItem] =
		createSignal<InstructionPageItem | null>(null);
	const [uscSourceVersions, setUscSourceVersions] = createSignal<
		SourceVersionRecord[]
	>([]);
	const [selectedUscSourceVersionId, setSelectedUscSourceVersionId] =
		createSignal("");

	const [pageLayouts, setPageLayouts] = createSignal<PageLayout[]>([]);
	const [allItems, setAllItems] = createSignal<
		{ item: PageItem; pageNumber: number }[]
	>([]);
	const visibleItems = createMemo(() => {
		const indexes = virtualIndexes();
		if (indexes.length === 0) return [];

		const startPage = Math.max(0, indexes[0] - 1);
		const endPage = indexes[indexes.length - 1] + 1;

		const layouts = pageLayouts();
		if (layouts.length === 0) return [];

		return allItems()
			.filter(
				(item) =>
					item.pageNumber >= startPage + 1 && item.pageNumber <= endPage + 1,
			)
			.map((entry) => {
				const layout = layouts[entry.pageNumber - 1];
				if (!layout) return null;
				// Calculate global top based on topPercent
				const topPercent =
					entry.item.type === "paragraph"
						? entry.item.topPercent
						: entry.item.topPercent;
				// Add padding top to align with visual rendering
				// Subtract ~18px because extraction Y is baseline, not top
				const globalTop =
					layout.pageOffset + 24 + (topPercent / 100) * layout.pageHeight;

				return {
					item: entry.item,
					globalTop,
					pageNumber: entry.pageNumber,
				};
			})
			.filter((i): i is NonNullable<typeof i> => i !== null);
	});

	// Refs and state for PDF rendering
	let currentPdf: PDFDocumentProxy | null = null;
	let pdfjsLib: Awaited<typeof import("pdfjs-dist")> | null = null;
	let currentFileHash: string | null = null;
	let initialScrollTargetPage = 1;
	let hasAppliedInitialScroll = false;
	let processVersion = 0;
	let processingWorker: Worker | null = null;

	const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		get count() {
			return pageRows().length;
		},
		getScrollElement: () => scrollContainer(),
		initialRect: {
			width: 0,
			height: typeof window === "undefined" ? 800 : window.innerHeight,
		},
		estimateSize: (i) => {
			const layouts = pageLayouts();
			if (layouts[i]) {
				const padding = 48; // 24 top + 24 bottom
				return layouts[i].pageHeight + padding;
			}
			return DEFAULT_ITEM_SIZE;
		},
		overscan: 3,
		onChange(instance) {
			const items = instance.getVirtualItems();

			const nextIndexes = items.map((item) => item.index);
			const nextStarts = items.map((item) => item.start);
			const nextSizes = items.map((item) => item.size);

			const arraysEqual = (a: number[], b: number[]) =>
				a.length === b.length && a.every((v, i) => v === b[i]);

			batch(() => {
				if (!arraysEqual(nextIndexes, virtualIndexes())) {
					setVirtualIndexes(nextIndexes);
				}
				if (!arraysEqual(nextStarts, virtualStarts())) {
					setVirtualStarts(nextStarts);
				}
				if (!arraysEqual(nextSizes, virtualSizes())) {
					setVirtualSizes(nextSizes);
				}
			});
		},
	});

	// On HMR, null out the scroll container so the virtualizer detaches its
	// observers from the now-removed DOM element.
	onCleanup(() => {
		setScrollContainer(null);
		processingWorker?.terminate();
		processingWorker = null;
		if (typeof window !== "undefined") {
			window.removeEventListener("hashchange", handleHashChange);
		}
	});

	createEffect(() => {
		if (!selectedInstructionItem()) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setSelectedInstructionItem(null);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	const virtualRangeLabel = createMemo(() => {
		const indexes = virtualIndexes();
		if (indexes.length === 0) return "empty";
		return `${indexes[0]}-${indexes[indexes.length - 1]}`;
	});

	createEffect(() => {
		if (!scrollContainer() || pageRows().length === 0) return;
		pageRows();
		requestAnimationFrame(() => rowVirtualizer.measure());
	});

	// Derive the topmost visible page from virtualizer state.
	const currentPage = createMemo(() => {
		const scrollTop = lastScrollTop();
		const indexes = virtualIndexes();
		const starts = virtualStarts();
		const sizes = virtualSizes();

		for (let i = 0; i < indexes.length; i++) {
			if (starts[i] + sizes[i] > scrollTop) {
				return indexes[i] + 1;
			}
		}
		return indexes.length > 0 ? indexes[indexes.length - 1] + 1 : 1;
	});

	// Debounce-update #page= in the URL as the user scrolls.
	// Skip updates until the initial scroll has been applied to avoid flashing #page=1.
	createEffect(() => {
		const page = currentPage();
		if (!currentFileHash || !hasAppliedInitialScroll) return;
		const timeout = setTimeout(() => replaceLocationHash(page), 150);
		onCleanup(() => clearTimeout(timeout));
	});

	const handleHashChange = () => {
		const parsed = parseHashState();
		if (!parsed || !currentFileHash) return;
		if (
			parsed.sourceVersionId &&
			parsed.sourceVersionId !== selectedUscSourceVersionId() &&
			uscSourceVersions().some(
				(version) => version.id === parsed.sourceVersionId,
			)
		) {
			setSelectedUscSourceVersionId(parsed.sourceVersionId);
		}

		// If the document hash matches but the page is different, scroll to it.
		if (parsed.hash === currentFileHash && parsed.page !== currentPage()) {
			rowVirtualizer.scrollToIndex(parsed.page - 1, { align: "start" });
		}
	};

	const reset = (keepHash = false) => {
		processingWorker?.terminate();
		processingWorker = null;
		setFile(null);
		setPageRows([]);
		setPageLayouts([]);
		setAllItems([]);
		setRenderContext(null);
		setStatus("idle");
		setError(null);
		setFileName("");
		setSelectedInstructionItem(null);
		currentPdf = null;
		currentFileHash = null;
		initialScrollTargetPage = 1;
		hasAppliedInitialScroll = false;
		processVersion += 1;
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
		const sourceVersionId = params.get("sourceVersionId")?.trim() || null;
		return { hash, page, sourceVersionId };
	};

	const replaceLocationHash = (page: number) => {
		if (!currentFileHash || typeof window === "undefined") return;
		const params = new URLSearchParams();
		params.set("page", String(page));
		params.set("hash", currentFileHash);
		if (selectedUscSourceVersionId()) {
			params.set("sourceVersionId", selectedUscSourceVersionId());
		}
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
			const hashVersionId = parseHashState()?.sourceVersionId;
			try {
				const response = await fetch("/api/sources/usc/versions");
				if (response.ok) {
					const payload = (await response.json()) as SourceVersionsResponse;
					setUscSourceVersions(payload.versions);

					const defaultVersionId =
						hashVersionId &&
						payload.versions.some((v) => v.id === hashVersionId)
							? hashVersionId
							: payload.versions[0]?.id;
					if (defaultVersionId) {
						setSelectedUscSourceVersionId(defaultVersionId);
					}
				}
			} catch (err) {
				console.error("Failed to load USC source versions:", err);
			}
		}

		window.addEventListener("hashchange", handleHashChange);
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
				items: [],
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

	const startProcessingWorker = (
		activeProcessVersion: number,
		fileBuffer: ArrayBuffer,
		targetPage: number,
		sourceVersionId: string,
	) => {
		processingWorker?.terminate();
		const worker = new Worker(
			new URL("./lib/pdf/processing.worker.ts", import.meta.url),
			{ type: "module" },
		);
		processingWorker = worker;

		worker.addEventListener(
			"message",
			(event: MessageEvent<ProcessingWorkerResponse>) => {
				const message = event.data;
				if (message.jobId !== activeProcessVersion) return;
				if (activeProcessVersion !== processVersion) return;
				if (message.type === "layouts") {
					setPageLayouts(message.layouts);
					requestAnimationFrame(() => rowVirtualizer.measure());
					return;
				}
				if (message.type === "windowItems") {
					setAllItems(message.payload.items);
					return;
				}
				if (message.type === "allItems") {
					setAllItems(message.payload.items);
					return;
				}
				if (message.type === "error") {
					console.error("Error extracting text:", message.error);
					setError(message.error);
					setStatus("error");
				}
			},
		);

		worker.addEventListener("error", (event) => {
			if (activeProcessVersion !== processVersion) return;
			const errorMessage = event.message || "Worker failed";
			console.error("Processing worker error:", errorMessage);
			setError(errorMessage);
			setStatus("error");
		});

		worker.postMessage(
			{
				type: "start",
				jobId: activeProcessVersion,
				fileBuffer,
				targetPage,
				sourceVersionId,
				numAmendColors: NUM_AMEND_COLORS,
				windowRadius: 4,
			},
			[fileBuffer],
		);
	};

	const processFile = async (
		selectedFile: File,
		shouldPersist = true,
		existingHash?: string,
		initialPage = 1,
	) => {
		const activeProcessVersion = processVersion + 1;
		reset(true); // clear previous state logic, but keep hash initially
		processVersion = activeProcessVersion;

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
			replaceLocationHash(initialPage);

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
			const workerBuffer = arrayBuffer.slice(0);
			const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
			currentPdf = await loadingTask.promise;
			if (!currentPdf) {
				console.error("Failed to load PDF...");
				return;
			}
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
			startProcessingWorker(
				activeProcessVersion,
				workerBuffer,
				targetPage,
				selectedUscSourceVersionId(),
			);
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
	};

	createEffect(() => {
		const sourceVersionId = selectedUscSourceVersionId();
		if (!sourceVersionId || !currentFileHash || !hasAppliedInitialScroll)
			return;
		replaceLocationHash(currentPage());
	});

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
						<PdfUploadDropzone
							sourceVersions={uscSourceVersions()}
							selectedSourceVersionId={selectedUscSourceVersionId()}
							onSourceVersionChange={setSelectedUscSourceVersionId}
							onFileSelected={(file) => {
								void processFile(file, true);
							}}
						/>
					</Show>

					<Show when={status() === "processing"}>
						<p>Processing...</p>
					</Show>

					<Show when={error()}>
						<p class="pdf-error-text">Error processing PDF: {error()}</p>
					</Show>

					<PdfWorkspace
						status={status()}
						isVirtualDebugEnabled={isVirtualDebugEnabled()}
						pageRowCount={pageRows().length}
						virtualRangeLabel={virtualRangeLabel()}
						virtualIndexes={virtualIndexes()}
						virtualStarts={virtualStarts()}
						virtualSizes={virtualSizes()}
						defaultItemSize={DEFAULT_ITEM_SIZE}
						lastScrollTop={lastScrollTop()}
						lastViewportHeight={lastViewportHeight()}
						totalSize={rowVirtualizer.getTotalSize()}
						renderContext={renderContext()}
						visibleItems={visibleItems()}
						onInstructionClick={setSelectedInstructionItem}
						onScrollContainerRef={scrollContainerRef}
						onScroll={handleScroll}
						onPageRenderSuccess={handlePageRenderSuccess}
						onPageRenderError={handlePageRenderError}
					/>
					<InstructionDebugModal
						item={selectedInstructionItem()}
						onClose={() => setSelectedInstructionItem(null)}
					/>
				</main>
			</div>
		</MetaProvider>
	);
}
