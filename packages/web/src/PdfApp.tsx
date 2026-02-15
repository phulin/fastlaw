import { MetaProvider, Title } from "@solidjs/meta";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { AnnotationLayer, type PageLayout } from "./components/AnnotationLayer";
import { Header } from "./components/Header";
import type { InstructionPageItem, PageItem } from "./components/PageRow";
import { PageRow } from "./components/PageRow";
import "pdfjs-dist/web/pdf_viewer.css";
import {
	type AmendatoryInstruction,
	extractAmendatoryInstructions,
} from "./lib/amendatory-instructions";
import {
	computeAmendmentEffect,
	getSectionBodyText,
	getSectionPathFromUscCitation,
	type SectionBodiesResponse,
} from "./lib/amendment-effects";
import { renderMarkdown } from "./lib/markdown";
import type { Paragraph } from "./lib/text-extract";
import { extractParagraphs } from "./lib/text-extract";
import type { NodeContent, SourceVersionRecord } from "./lib/types";

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

const fetchSectionBodies = async (
	paths: string[],
	sourceVersionId?: string,
): Promise<Map<string, NodeContent>> => {
	const requestBody: {
		paths: string[];
		sourceVersionId?: string;
	} = { paths };
	if (sourceVersionId && sourceVersionId.length > 0) {
		requestBody.sourceVersionId = sourceVersionId;
	}

	const response = await fetch("/api/statutes/section-bodies", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(requestBody),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch section bodies: HTTP ${response.status}`);
	}

	const payload = (await response.json()) as SectionBodiesResponse;
	const sectionBodies = new Map<string, NodeContent>();
	for (const result of payload.results) {
		if (result.status !== "ok") continue;
		sectionBodies.set(result.path, result.content);
	}
	return sectionBodies;
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
	let fileInput: HTMLInputElement | undefined;
	let currentPdf: PDFDocumentProxy | null = null;
	let pdfjsLib: Awaited<typeof import("pdfjs-dist")> | null = null;
	let currentFileHash: string | null = null;
	let initialScrollTargetPage = 1;
	let hasAppliedInitialScroll = false;
	let paragraphApplyVersion = 0;

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
		setFile(null);
		setPageRows([]);
		setStatus("idle");
		setError(null);
		setFileName("");
		setSelectedInstructionItem(null);
		if (fileInput) fileInput.value = "";
		currentPdf = null;
		currentFileHash = null;
		initialScrollTargetPage = 1;
		hasAppliedInitialScroll = false;
		paragraphApplyVersion += 1;
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

			// Pre-calculate page layouts
			const layouts: PageLayout[] = [];
			let currentOffset = 0;
			const PAGE_PADDING_TOP = 24;
			const PAGE_PADDING_BOTTOM = 24;

			// We need to fetch all page viewports to know heights
			// This might be slow for massive PDFs, but necessary for global layout
			const currentPdfNonNull: PDFDocumentProxy = currentPdf;
			void Promise.all(
				Array.from({ length: currentPdfNonNull.numPages }, (_, i) =>
					currentPdfNonNull.getPage(i + 1),
				),
			).then((pages) => {
				const baseScale = 1.3; // Match PageRow scale

				for (const page of pages) {
					const viewport = page.getViewport({ scale: baseScale });

					layouts.push({
						pageOffset: currentOffset,
						pageHeight: viewport.height,
						pageWidth: viewport.width,
					});
					currentOffset +=
						viewport.height + PAGE_PADDING_TOP + PAGE_PADDING_BOTTOM;
				}
				setPageLayouts(layouts);
			});

			setupPageRows();
			const pdf = currentPdf;
			const sectionBodyCache = new Map<string, NodeContent>();

			const applyParagraphs = async (allParagraphs: Paragraph[]) => {
				const applyVersion = ++paragraphApplyVersion;
				const instructions = extractAmendatoryInstructions(allParagraphs);
				const sectionPathByInstruction = new Map<
					AmendatoryInstruction,
					string
				>();
				const unresolvedPaths: string[] = [];

				for (const instruction of instructions) {
					const sectionPath = getSectionPathFromUscCitation(
						instruction.uscCitation,
					);
					if (!sectionPath) continue;
					sectionPathByInstruction.set(instruction, sectionPath);
					if (!sectionBodyCache.has(sectionPath)) {
						unresolvedPaths.push(sectionPath);
					}
				}

				if (unresolvedPaths.length > 0) {
					const dedupedPaths = [...new Set(unresolvedPaths)];
					const fetched = await fetchSectionBodies(
						dedupedPaths,
						selectedUscSourceVersionId(),
					);
					if (applyVersion !== paragraphApplyVersion) return;
					for (const [path, content] of fetched.entries()) {
						sectionBodyCache.set(path, content);
					}
				}

				const instructionParagraphs = new Set<Paragraph>();
				const instructionMap = new Map<Paragraph, AmendatoryInstruction>();

				for (const instr of instructions) {
					for (const p of instr.paragraphs) {
						instructionParagraphs.add(p);
						if (p === instr.paragraphs[0]) {
							instructionMap.set(p, instr);
						}
					}
				}

				const newItems: { item: PageItem; pageNumber: number }[] = [];

				for (const p of allParagraphs) {
					if (instructionParagraphs.has(p)) {
						// Only add the instruction item if this paragraph is the *start* of the instruction
						const instr = instructionMap.get(p);
						if (instr) {
							const topPercent = instr.paragraphs[0]?.pageHeight
								? ((instr.paragraphs[0].pageHeight - instr.paragraphs[0].y) /
										instr.paragraphs[0].pageHeight) *
									100
								: 0;
							const sectionPath = sectionPathByInstruction.get(instr) ?? null;
							const sectionContent = sectionPath
								? sectionBodyCache.get(sectionPath)
								: undefined;
							const sectionBodyText = getSectionBodyText(sectionContent);
							const amendmentEffect =
								sectionPath && sectionBodyText.length > 0
									? computeAmendmentEffect(instr, sectionPath, sectionBodyText)
									: null;

							newItems.push({
								item: {
									type: "instruction",
									instruction: instr,
									amendmentEffect,
									sectionPath,
									colorIndex: instructions.indexOf(instr) % NUM_AMEND_COLORS,
									topPercent,
								},
								pageNumber: p.startPage,
							});
						}
					} else {
						const topPercent =
							p.pageHeight > 0
								? ((p.pageHeight - p.yStart) / p.pageHeight) * 100
								: 0;

						newItems.push({
							item: {
								type: "paragraph",
								text: p.text,
								colorIndex: null,
								topPercent,
							},
							pageNumber: p.startPage,
						});
					}
				}

				if (applyVersion !== paragraphApplyVersion) return;
				setAllItems(newItems);
			};

			const windowStart = Math.max(1, targetPage - 4);
			const windowEnd = Math.min(pdf.numPages, targetPage + 4);

			void extractParagraphs(pdf, {
				startPage: windowStart,
				endPage: windowEnd,
			})
				.then((windowParagraphs) => {
					return applyParagraphs(windowParagraphs);
				})
				.then(() => {
					return extractParagraphs(pdf);
				})
				.then((allParagraphs) => {
					return applyParagraphs(allParagraphs);
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

	const handleDropzoneClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest(".pdf-upload-options")) return;
		fileInput?.click();
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
						<section
							class="pdf-dropzone"
							onDragOver={handleDragOver}
							onDrop={handleDrop}
							onClick={handleDropzoneClick}
							onKeyPress={(e) => {
								if (e.key === "Enter" || e.key === " ") fileInput?.click();
							}}
							aria-label="PDF drop zone"
							tabindex="0"
						>
							<h1 class="pdf-dropzone-title">Upload PDF</h1>
							<p>Drag and drop a PDF file here, or click to select</p>
							<div class="pdf-upload-options">
								<label class="pdf-upload-field">
									<span>USC source version</span>
									<select
										class="pdf-upload-select"
										value={selectedUscSourceVersionId()}
										onChange={(event) =>
											setSelectedUscSourceVersionId(event.currentTarget.value)
										}
									>
										<For each={uscSourceVersions()}>
											{(version) => (
												<option value={version.id}>
													{version.id} ({version.version_date})
												</option>
											)}
										</For>
									</select>
								</label>
							</div>
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
						style={{
							display: status() !== "idle" ? "grid" : "none",
							"grid-template-columns": "1fr 1fr",
						}}
					>
						<Show when={isVirtualDebugEnabled()}>
							<output class="pdf-virtualizer-debug">
								<span>count: {pageRows().length}</span>
								<span>range: {virtualRangeLabel()}</span>
								<span>rendered: {virtualIndexes().length}</span>
								<span>scrollTop: {Math.round(lastScrollTop())}</span>
								<span>viewport: {Math.round(lastViewportHeight())}</span>
								<span>
									totalSize: {Math.round(rowVirtualizer.getTotalSize())}
								</span>
							</output>
						</Show>

						{/* Left Column: PDF Pages */}
						<div class="pdf-column-viewer">
							<Show when={status() !== "idle"}>
								<div
									class="pdf-virtualizer-size"
									style={{
										height: `${rowVirtualizer.getTotalSize()}px`,
									}}
								>
									<For each={virtualIndexes()}>
										{(index, listIndex) => (
											<div
												data-index={index}
												data-start={Math.round(
													virtualStarts()[listIndex()] ??
														index * DEFAULT_ITEM_SIZE,
												)}
												data-size={Math.round(
													virtualSizes()[listIndex()] ?? DEFAULT_ITEM_SIZE,
												)}
												class="pdf-virtualizer-item"
												style={{
													transform: `translateY(${
														virtualStarts()[listIndex()] ??
														index * DEFAULT_ITEM_SIZE
													}px)`,
												}}
											>
												<Show when={isVirtualDebugEnabled()}>
													<div class="pdf-virtualizer-item-debug">
														#{index + 1} y=
														{Math.round(
															virtualStarts()[listIndex()] ??
																index * DEFAULT_ITEM_SIZE,
														)}{" "}
														h=
														{Math.round(
															virtualSizes()[listIndex()] ?? DEFAULT_ITEM_SIZE,
														)}
													</div>
												</Show>
												<PageRow
													pageNumber={index + 1}
													pdf={renderContext()?.pdf}
													pdfjsLib={renderContext()?.pdfjsLib}
													onRenderSuccess={handlePageRenderSuccess}
													onRenderError={handlePageRenderError}
												/>
											</div>
										)}
									</For>
								</div>
							</Show>
						</div>

						{/* Right Column: Annotations */}
						<div class="pdf-column-annotations">
							<AnnotationLayer
								items={visibleItems()}
								totalHeight={rowVirtualizer.getTotalSize()}
								width={0} // handled by CSS
								onInstructionClick={(instructionItem) =>
									setSelectedInstructionItem(instructionItem)
								}
							/>
						</div>
					</div>
					<Show when={selectedInstructionItem()}>
						<div class="pdf-instruction-modal-backdrop">
							<div
								class="pdf-instruction-modal"
								role="dialog"
								aria-modal="true"
								aria-label="Instruction match details"
							>
								<header class="pdf-instruction-modal-header">
									<h2 class="pdf-instruction-modal-title">
										Instruction Match Details
									</h2>
									<button
										type="button"
										class="pdf-secondary-button"
										onClick={() => setSelectedInstructionItem(null)}
									>
										Close
									</button>
								</header>
								<Show when={selectedInstructionItem()}>
									{(selected) => {
										const item = selected();
										const instruction = item.instruction;
										const effect = item.amendmentEffect;
										const instructionPageRange = `${instruction.startPage}-${instruction.endPage}`;
										const hierarchyPath = instruction.rootQuery
											.map((level) =>
												level.type === "none"
													? null
													: `${level.type}:${level.val}`,
											)
											.filter(
												(value): value is Exclude<typeof value, null> =>
													value !== null,
											)
											.join(" > ");

										return (
											<div class="pdf-instruction-modal-content">
												<div class="pdf-instruction-modal-grid">
													<div class="pdf-instruction-modal-kv">
														<span>Bill section</span>
														<code>{instruction.billSection ?? "n/a"}</code>
													</div>
													<div class="pdf-instruction-modal-kv">
														<span>USC citation</span>
														<code>{instruction.uscCitation ?? "n/a"}</code>
													</div>
													<div class="pdf-instruction-modal-kv">
														<span>Section path</span>
														<code>{item.sectionPath ?? "n/a"}</code>
													</div>
													<div class="pdf-instruction-modal-kv">
														<span>Status</span>
														<code>{effect?.status ?? "uncomputed"}</code>
													</div>
													<div class="pdf-instruction-modal-kv">
														<span>Instruction pages</span>
														<code>{instructionPageRange}</code>
													</div>
													<div class="pdf-instruction-modal-kv">
														<span>Root target path</span>
														<code>{hierarchyPath || "n/a"}</code>
													</div>
												</div>

												<section class="pdf-instruction-modal-section">
													<h3>Instruction Text</h3>
													<div
														class="pdf-instruction-modal-markdown markdown"
														innerHTML={renderMarkdown(instruction.text)}
													/>
												</section>

												<Show
													when={effect}
													fallback={
														<section class="pdf-instruction-modal-section">
															<h3>Match Attempts</h3>
															<p>No section body was available for matching.</p>
														</section>
													}
												>
													{(resolvedEffect) => (
														<section class="pdf-instruction-modal-section">
															<h3>Match Attempts</h3>
															<div class="pdf-instruction-modal-grid">
																<div class="pdf-instruction-modal-kv">
																	<span>Failure reason</span>
																	<code>
																		{resolvedEffect().debug.failureReason ??
																			"none"}
																	</code>
																</div>
																<div class="pdf-instruction-modal-kv">
																	<span>Section text length</span>
																	<code>
																		{String(
																			resolvedEffect().debug.sectionTextLength,
																		)}
																	</code>
																</div>
																<div class="pdf-instruction-modal-kv">
																	<span>Operation count</span>
																	<code>
																		{String(
																			resolvedEffect().debug.operationCount,
																		)}
																	</code>
																</div>
															</div>
															<For
																each={resolvedEffect().debug.operationAttempts}
															>
																{(attempt, index) => (
																	<article class="pdf-instruction-attempt">
																		<h4>Attempt {index() + 1}</h4>
																		<div class="pdf-instruction-modal-grid">
																			<div class="pdf-instruction-modal-kv">
																				<span>Operation</span>
																				<code>{attempt.operationType}</code>
																			</div>
																			<div class="pdf-instruction-modal-kv">
																				<span>Outcome</span>
																				<code>{attempt.outcome}</code>
																			</div>
																			<div class="pdf-instruction-modal-kv">
																				<span>Target path</span>
																				<code>
																					{attempt.targetPath ?? "n/a"}
																				</code>
																			</div>
																			<div class="pdf-instruction-modal-kv">
																				<span>Scoped range</span>
																				<code>
																					{attempt.scopedRange
																						? `${attempt.scopedRange.start}-${attempt.scopedRange.end} (${attempt.scopedRange.length} chars)`
																						: "none"}
																				</code>
																			</div>
																			<div class="pdf-instruction-modal-kv">
																				<span>Search kind</span>
																				<code>{attempt.searchTextKind}</code>
																			</div>
																			<div class="pdf-instruction-modal-kv">
																				<span>Search index</span>
																				<code>
																					{attempt.searchIndex === null
																						? "none"
																						: String(attempt.searchIndex)}
																				</code>
																			</div>
																		</div>

																		<div class="pdf-instruction-modal-kv">
																			<span>Search text</span>
																			<pre class="pdf-instruction-modal-code">
																				{attempt.searchText ?? "n/a"}
																			</pre>
																		</div>

																		<div class="pdf-instruction-modal-kv">
																			<span>Scoped text preview</span>
																			<pre class="pdf-instruction-modal-code">
																				{attempt.scopedRange?.preview ?? "n/a"}
																			</pre>
																		</div>

																		<div class="pdf-instruction-modal-kv">
																			<span>Operation text</span>
																			<pre class="pdf-instruction-modal-code">
																				{attempt.nodeText}
																			</pre>
																		</div>
																	</article>
																)}
															</For>
														</section>
													)}
												</Show>
											</div>
										);
									}}
								</Show>
							</div>
						</div>
					</Show>
				</main>
			</div>
		</MetaProvider>
	);
}
