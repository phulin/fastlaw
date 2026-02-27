import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { FailedApplyItem } from "../lib/amendment-edit-tree-apply";
import { buildPageItemsFromParagraphs } from "../lib/pdf/page-items";
import { extractParagraphs } from "../lib/text-extract";
import type { NodeContent } from "../lib/types";

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

export interface FailedInstructionResult {
	instructionIndex: number;
	pageNumber: number;
	billSection: string | null;
	uscCitation: string | null;
	targetScopePath: string;
	sectionPath: string | null;
	failedItems: FailedApplyItem[];
}

export interface RunPdfPipelineFailuresArgs {
	pdfPath: string;
	baseUrl: string;
	sourceVersionId: string;
}

export interface RunPdfPipelineFailuresResult {
	pdfPath: string;
	baseUrl: string;
	sourceVersionId: string;
	instructionCount: number;
	failedInstructionCount: number;
	failedInstructions: FailedInstructionResult[];
}

const expandTilde = (path: string): string => {
	const home = process.env.HOME ?? homedir();
	if (path === "~") return home;
	if (!path.startsWith("~/")) return path;
	return resolve(home, path.slice(2));
};

const fetchSectionBodies = async (
	baseUrl: string,
	paths: string[],
	sourceVersionId: string,
): Promise<Map<string, NodeContent>> => {
	const sectionBodies = new Map<string, NodeContent>();
	const chunkSize = 100;
	const maxAttempts = 4;
	for (let start = 0; start < paths.length; start += chunkSize) {
		const chunk = paths.slice(start, start + chunkSize);
		let attempt = 0;
		while (attempt < maxAttempts) {
			attempt += 1;
			try {
				const response = await fetch(`${baseUrl}/api/statutes/section-bodies`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ paths: chunk, sourceVersionId }),
				});

				if (!response.ok) {
					throw new Error(
						`Failed to fetch section bodies: HTTP ${response.status} ${response.statusText}`,
					);
				}

				const payload = (await response.json()) as SectionBodiesResponse;
				for (const result of payload.results) {
					if (result.status !== "ok") continue;
					sectionBodies.set(result.path, result.content);
				}
				break;
			} catch (error) {
				if (attempt >= maxAttempts) {
					throw error;
				}
				await new Promise((resolveRetryDelay) =>
					setTimeout(resolveRetryDelay, 200 * attempt),
				);
			}
		}
	}
	return sectionBodies;
};

export const resolveSourceVersionId = async (
	baseUrl: string,
	explicitSourceVersionId?: string,
): Promise<string> => {
	if (explicitSourceVersionId) return explicitSourceVersionId;

	const response = await fetch(`${baseUrl}/api/sources/usc/versions`);
	if (!response.ok) {
		throw new Error(
			`Failed to load USC source versions: HTTP ${response.status} ${response.statusText}`,
		);
	}
	const payload = (await response.json()) as {
		versions: Array<{ id: string }>;
	};
	const sourceVersionId = payload.versions[0]?.id;
	if (!sourceVersionId) {
		throw new Error("No USC source versions available");
	}
	return sourceVersionId;
};

export const runPdfPipelineFailures = async (
	args: RunPdfPipelineFailuresArgs,
): Promise<RunPdfPipelineFailuresResult> => {
	const sectionBodyCache = new Map<string, NodeContent>();
	const data = new Uint8Array(await readFile(expandTilde(args.pdfPath)));
	// @ts-expect-error PDF.js runtime supports this option.
	const loadingTask = getDocument({ data, disableWorker: true });
	const pdf = await loadingTask.promise;

	try {
		const paragraphs = await extractParagraphs(pdf);
		const pageItems = await buildPageItemsFromParagraphs({
			paragraphs,
			sectionBodyCache,
			sourceVersionId: args.sourceVersionId,
			numAmendColors: 6,
			fetchSectionBodies: (paths, sourceVersionId) =>
				fetchSectionBodies(
					args.baseUrl,
					paths,
					sourceVersionId ?? args.sourceVersionId,
				),
		});

		const failedInstructions: FailedInstructionResult[] = pageItems
			.filter(
				(entry): entry is typeof entry & { item: { type: "instruction" } } => {
					return entry.item.type === "instruction";
				},
			)
			.map((entry, instructionIndex) => ({
				entry,
				instructionIndex,
			}))
			.filter(({ entry }) => {
				return (
					(entry.item.amendmentEffect?.applySummary.failedItems.length ?? 0) > 0
				);
			})
			.map(({ entry, instructionIndex }) => ({
				instructionIndex,
				pageNumber: entry.pageNumber,
				billSection: entry.item.instruction.billSection,
				uscCitation: entry.item.instruction.uscCitation,
				targetScopePath: entry.item.instruction.targetScopePath,
				sectionPath: entry.item.sectionPath,
				failedItems: entry.item.amendmentEffect?.applySummary.failedItems ?? [],
			}));

		const instructionCount = pageItems.filter(
			(entry) => entry.item.type === "instruction",
		).length;

		return {
			pdfPath: expandTilde(args.pdfPath),
			baseUrl: args.baseUrl,
			sourceVersionId: args.sourceVersionId,
			instructionCount,
			failedInstructionCount: failedInstructions.length,
			failedInstructions,
		};
	} finally {
		await pdf.destroy();
	}
};

const baseUrl = process.env.PDF_PIPELINE_BASE_URL ?? "http://localhost:5173";

if (!process.env.VITEST && import.meta.url === `file://${process.argv[1]}`) {
	const pdfPath = process.argv[2] ?? "~/Downloads/BILLS-119hr1eas.pdf";
	const sourceVersionIdArg = process.argv[3];
	void resolveSourceVersionId(baseUrl, sourceVersionIdArg)
		.then((sourceVersionId) =>
			runPdfPipelineFailures({
				pdfPath,
				baseUrl,
				sourceVersionId,
			}),
		)
		.then((result) => {
			console.log(JSON.stringify(result, null, 2));
		})
		.catch((error: unknown) => {
			console.error(error);
			process.exit(1);
		});
}
