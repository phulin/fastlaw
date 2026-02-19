import type { Paragraph } from "../text-extract";
import { extractParagraphs } from "../text-extract";
import type { NodeContent } from "../types";
import { buildPageItemsFromParagraphs } from "./page-items";
import type {
	ProcessingWorkerRequest,
	ProcessingWorkerResponse,
	WorkerPageItemsPayload,
} from "./processing-worker-types";

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

const postResponse = (message: ProcessingWorkerResponse) => {
	self.postMessage(message);
};

const createItemsPayload = async (
	paragraphs: Paragraph[],
	sectionBodyCache: Map<string, NodeContent>,
	sourceVersionId: string,
	numAmendColors: number,
): Promise<WorkerPageItemsPayload> => {
	const items = await buildPageItemsFromParagraphs({
		paragraphs,
		sectionBodyCache,
		sourceVersionId,
		numAmendColors,
		fetchSectionBodies,
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
				const pdfjsLib = await import("pdfjs-dist");
				// @ts-expect-error - PDF.js types mismatch
				await import("pdfjs-dist/build/pdf.worker.mjs");
				if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
					pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
						"pdfjs-dist/build/pdf.worker.mjs",
						import.meta.url,
					).toString();
				}
				const loadingTask = pdfjsLib.getDocument({ data: message.fileBuffer });
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

				const windowParagraphs = await extractParagraphs(pdf, {
					startPage: windowStart,
					endPage: windowEnd,
				});
				const windowPayload = await createItemsPayload(
					windowParagraphs,
					sectionBodyCache,
					message.sourceVersionId,
					message.numAmendColors,
				);
				postResponse({
					type: "windowItems",
					jobId: message.jobId,
					payload: windowPayload,
				});

				const allParagraphs = await extractParagraphs(pdf);
				const allPayload = await createItemsPayload(
					allParagraphs,
					sectionBodyCache,
					message.sourceVersionId,
					message.numAmendColors,
				);
				postResponse({
					type: "allItems",
					jobId: message.jobId,
					payload: allPayload,
				});
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
