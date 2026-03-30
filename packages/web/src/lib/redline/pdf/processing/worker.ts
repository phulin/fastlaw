import * as pdfjsLib from "pdfjs-dist";
import type { ClassificationOverride } from "../../../amendment-edit-engine-types";
import { LruCache } from "../../../lru-cache";
import { extractParagraphs } from "../../../text-extract";
import type { NodeContent, Paragraph } from "../../../types";
import {
	type AmendmentPipelineCaches,
	type AmendmentPipelinePerfStats,
	buildPageItemsFromParagraphs,
} from "./build-page-items";

import type {
	ProcessingWorkerRequest,
	ProcessingWorkerResponse,
	WorkerPageItemsPayload,
} from "./worker-types";

interface SectionBodiesResponse {
	results: Array<
		| {
				path: string;
				status: "ok";
				content: NodeContent;
		  }
		| {
				path: string;
				status: "not_found" | "error";
				error?: string;
		  }
	>;
}

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

const fetchClassificationOverrides = async (): Promise<
	ClassificationOverride[]
> => {
	const response = await fetch("/api/statutes/classifications");
	if (!response.ok) {
		console.warn(
			`Failed to fetch classification overrides: HTTP ${response.status}`,
		);
		return [];
	}
	const payload = (await response.json()) as {
		results: ClassificationOverride[];
	};
	return payload.results || [];
};

const postResponse = (message: ProcessingWorkerResponse) => {
	self.postMessage(message);
};

const createItemsPayload = async (
	paragraphs: Paragraph[],
	sectionBodyCache: Map<string, NodeContent>,
	sourceVersionId: string,
	numAmendColors: number,
	classificationOverrides: ClassificationOverride[],
	caches: AmendmentPipelineCaches,
	perfStats: AmendmentPipelinePerfStats,
): Promise<WorkerPageItemsPayload> => {
	const items = await buildPageItemsFromParagraphs({
		paragraphs,
		sectionBodyCache,
		sourceVersionId,
		numAmendColors,
		fetchSectionBodies,
		classificationOverrides,
		caches,
		perfStats,
	});
	return { items };
};

self.addEventListener(
	"message",
	(event: MessageEvent<ProcessingWorkerRequest>) => {
		const message = event.data;
		if (message.type !== "start") return;

		void (async () => {
			try {
				// DO NOT import pdf.worker.mjs here. If you import it in a Worker Global Scope,
				// it will hijack self.addEventListener('message') and break our worker!
				// Instead, just let getDocument use the fake worker synchronously or manually specify workerSrc
				// without executing the worker module in this scope.
				if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
					pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
						"pdfjs-dist/build/pdf.worker.mjs",
						import.meta.url,
					).toString();
				}

				const loadingTask = pdfjsLib.getDocument({
					data: message.fileBuffer,
					standardFontDataUrl:
						"https://unpkg.com/pdfjs-dist@4.4.168/standard_fonts/",
				});
				const pdf = await loadingTask.promise;

				const layouts: {
					pageOffset: number;
					pageHeight: number;
					pageWidth: number;
				}[] = [];
				let currentOffset = 0;
				const PAGE_PADDING_TOP = 24;
				const PAGE_PADDING_BOTTOM = 24;
				const baseScale = 1.3;

				for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
					const page = await pdf.getPage(pageNumber);
					const viewport = page.getViewport({ scale: baseScale });
					layouts.push({
						pageOffset: currentOffset,
						pageHeight: viewport.height,
						pageWidth: viewport.width,
					});
					currentOffset +=
						viewport.height + PAGE_PADDING_TOP + PAGE_PADDING_BOTTOM;
				}

				postResponse({
					type: "layouts",
					jobId: message.jobId,
					layouts,
				});

				const targetPage = Math.min(
					Math.max(1, Math.floor(message.targetPage)),
					pdf.numPages,
				);
				const windowStart = Math.max(1, targetPage - message.windowRadius);
				const windowEnd = Math.min(
					pdf.numPages,
					targetPage + message.windowRadius,
				);
				const sectionBodyCache = new Map<string, NodeContent>();
				const caches: AmendmentPipelineCaches = {
					canonicalDocumentBySectionKey: new LruCache(256),
					amendmentEffectByInstructionKey: new LruCache(256),
				};
				const perfStats: AmendmentPipelinePerfStats = {
					applyCallCount: 0,
					applyTotalMs: 0,
					canonicalCacheHits: 0,
					canonicalCacheMisses: 0,
					effectCacheHits: 0,
					effectCacheMisses: 0,
				};
				const classificationOverrides = await fetchClassificationOverrides();

				const windowParagraphs = await extractParagraphs(pdf, {
					startPage: windowStart,
					endPage: windowEnd,
				});
				const windowPayload = await createItemsPayload(
					windowParagraphs,
					sectionBodyCache,
					message.sourceVersionId,
					message.numAmendColors,
					classificationOverrides,
					caches,
					perfStats,
				);
				postResponse({
					type: "windowItems",
					jobId: message.jobId,
					payload: windowPayload,
				});
				console.log("finished processing window items");

				const allParagraphs = await extractParagraphs(pdf);
				const allPayload = await createItemsPayload(
					allParagraphs,
					sectionBodyCache,
					message.sourceVersionId,
					message.numAmendColors,
					classificationOverrides,
					caches,
					perfStats,
				);
				postResponse({
					type: "allItems",
					jobId: message.jobId,
					payload: allPayload,
				});
				console.log("finished processing all items");
				if (import.meta.env.DEV) {
					const applyAverageMs =
						perfStats.applyCallCount > 0
							? perfStats.applyTotalMs / perfStats.applyCallCount
							: 0;
					console.log("[amendment-perf]", {
						applyCallCount: perfStats.applyCallCount,
						applyTotalMs: Number(perfStats.applyTotalMs.toFixed(2)),
						applyAverageMs: Number(applyAverageMs.toFixed(3)),
						canonicalCacheHits: perfStats.canonicalCacheHits,
						canonicalCacheMisses: perfStats.canonicalCacheMisses,
						effectCacheHits: perfStats.effectCacheHits,
						effectCacheMisses: perfStats.effectCacheMisses,
					});
				}
			} catch (error: unknown) {
				postResponse({
					type: "error",
					jobId: message.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	},
);
