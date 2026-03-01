import { expect, test } from "vitest";
import {
	resolveSourceVersionId,
	runPdfPipelineFailures,
} from "./run-pdf-pipeline-failures";

test(
	"run PDF through amendment pipeline and print failed items",
	{ timeout: 600_000 },
	async () => {
		const baseUrl =
			process.env.PDF_PIPELINE_BASE_URL ?? "http://localhost:5173";
		const pdfPath =
			process.env.PDF_PIPELINE_PATH ?? "~/Downloads/BILLS-119hr1eas.pdf";
		const sourceVersionId = await resolveSourceVersionId(
			baseUrl,
			process.env.PDF_PIPELINE_SOURCE_VERSION_ID,
		);

		const result = await runPdfPipelineFailures({
			pdfPath,
			baseUrl,
			sourceVersionId,
		});

		console.log(JSON.stringify(result, null, 2));
		expect(result.instructionCount).toBeGreaterThan(0);
	},
);
