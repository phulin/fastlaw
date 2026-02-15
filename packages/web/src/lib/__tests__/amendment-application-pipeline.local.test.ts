import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { extractAmendatoryInstructions } from "../amendatory-instructions";
import {
	computeAmendmentEffect,
	getSectionBodyText,
	getSectionPathFromUscCitation,
} from "../amendment-effects";
import { extractParagraphs } from "../text-extract";
import type { NodeContent } from "../types";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../../..");

const PDF_PATH = resolve(homedir(), "Downloads/BILLS-119hr1eas.pdf");
const STATUTES_ORIGIN =
	process.env.AMENDMENT_STATUTES_ORIGIN ?? "http://localhost:5173";
const USC_SOURCE_VERSION =
	process.env.AMENDMENT_USC_SOURCE_VERSION ?? "usc@usc-118-274not159";
const OUTPUT_PATH = resolve(
	WEB_ROOT,
	"tmp/bills-119hr1eas-application-failures.json",
);

interface FailureEntry {
	instructionIndex: number;
	billSection: string | null;
	uscCitation: string;
	sectionPath: string;
	effectStatus: "ok" | "unsupported";
	failureReason: string | null;
	operationType: string;
	nodeText: string;
	strikingContent: string | null;
	targetPath: string | null;
	hasExplicitTargetPath: boolean;
	searchTextKind: "striking" | "anchor_before" | "anchor_after" | "none";
	searchText: string | null;
	outcome: "no_patch" | "scope_unresolved";
}

const toVersionedSectionJsonUrl = (sectionPath: string): string => {
	const versionedPath = sectionPath.replace(
		"/statutes/usc/section/",
		`/statutes/${USC_SOURCE_VERSION}/section/`,
	);
	return `${STATUTES_ORIGIN}${versionedPath}.json`;
};

describe.skipIf(!existsSync(PDF_PATH))(
	"local full amendment application pipeline",
	() => {
		it("writes all non-applied operation outcomes to a report file", async () => {
			const data = new Uint8Array(await readFile(PDF_PATH));
			// @ts-expect-error - PDF.js runtime supports this option; types lag behind.
			const loadingTask = getDocument({ data, disableWorker: true });
			const pdf = await loadingTask.promise;

			try {
				const paragraphs = await extractParagraphs(pdf);
				const instructions = extractAmendatoryInstructions(paragraphs);

				const sectionBodyCache = new Map<string, string>();
				const failures: FailureEntry[] = [];
				let appliedCount = 0;
				let totalAttemptCount = 0;

				for (const [instructionIndex, instruction] of instructions.entries()) {
					const uscCitation = instruction.uscCitation;
					if (!uscCitation) continue;

					const sectionPath = getSectionPathFromUscCitation(uscCitation);
					if (!sectionPath) continue;

					let sectionBody = sectionBodyCache.get(sectionPath);
					if (!sectionBody) {
						const response = await fetch(
							toVersionedSectionJsonUrl(sectionPath),
						);
						if (!response.ok) {
							throw new Error(
								`Failed to fetch section body for ${sectionPath}: HTTP ${response.status}`,
							);
						}
						const content = (await response.json()) as NodeContent;
						sectionBody = getSectionBodyText(content);
						sectionBodyCache.set(sectionPath, sectionBody);
					}

					const effect = computeAmendmentEffect(
						instruction,
						sectionPath,
						sectionBody,
					);
					for (const attempt of effect.debug.operationAttempts) {
						totalAttemptCount += 1;
						if (attempt.outcome === "applied") {
							appliedCount += 1;
							continue;
						}
						failures.push({
							instructionIndex,
							billSection: instruction.billSection,
							uscCitation,
							sectionPath,
							effectStatus: effect.status,
							failureReason: effect.debug.failureReason,
							operationType: attempt.operationType,
							nodeText: attempt.nodeText,
							strikingContent: attempt.strikingContent,
							targetPath: attempt.targetPath,
							hasExplicitTargetPath: attempt.hasExplicitTargetPath,
							searchTextKind: attempt.searchTextKind,
							searchText: attempt.searchText,
							outcome: attempt.outcome,
						});
					}
				}

				const report = {
					generatedAt: new Date().toISOString(),
					pdfPath: PDF_PATH,
					statutesOrigin: STATUTES_ORIGIN,
					uscSourceVersion: USC_SOURCE_VERSION,
					outputPath: OUTPUT_PATH,
					summary: {
						paragraphCount: paragraphs.length,
						instructionCount: instructions.length,
						sectionsFetched: sectionBodyCache.size,
						totalAttemptCount,
						appliedCount,
						failureCount: failures.length,
					},
					failures,
				};

				await mkdir(dirname(OUTPUT_PATH), { recursive: true });
				await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);

				expect(report.summary.instructionCount).toBeGreaterThan(0);
				expect(existsSync(OUTPUT_PATH)).toBe(true);
			} finally {
				await pdf.destroy();
			}
		}, 1_200_000);
	},
);
