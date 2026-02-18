import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { splitParagraphsBeamSearch } from "../lib/beam-paragraph-splitter";
import { extractParagraphs } from "../lib/text-extract";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "../..");
const TMP_DIR = resolve(WEB_ROOT, "tmp");

function formatParagraphOutput(
	paragraphs: Array<{
		text: string;
		startPage: number;
		endPage: number;
	}>,
): string {
	return `${paragraphs
		.map(
			(paragraph) =>
				`(p${paragraph.startPage}-${paragraph.endPage}) ${paragraph.text}`,
		)
		.join("\n")}\n`;
}

async function main(): Promise<void> {
	const pdfPath = process.argv[2];
	if (!pdfPath) {
		throw new Error(
			"Usage: yarn tsx src/scripts/compare-paragraph-splitters.ts <pdf-path>",
		);
	}

	const data = new Uint8Array(await readFile(pdfPath));
	// @ts-expect-error PDF.js runtime supports this option.
	const loadingTask = getDocument({ data, disableWorker: true });
	const pdf = await loadingTask.promise;

	try {
		const oldParagraphs = await extractParagraphs(pdf);
		const lines = oldParagraphs.flatMap((paragraph) => paragraph.lines);
		const newParagraphs = splitParagraphsBeamSearch(lines);

		await mkdir(TMP_DIR, { recursive: true });

		const oldOutputPath = resolve(TMP_DIR, "bills-119hr1eas-old-splitter.txt");
		const newOutputPath = resolve(TMP_DIR, "bills-119hr1eas-new-splitter.txt");
		const summaryPath = resolve(
			TMP_DIR,
			"bills-119hr1eas-splitter-summary.json",
		);

		await writeFile(oldOutputPath, formatParagraphOutput(oldParagraphs));
		await writeFile(newOutputPath, formatParagraphOutput(newParagraphs));
		await writeFile(
			summaryPath,
			`${JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					pdfPath,
					lineCount: lines.length,
					oldParagraphCount: oldParagraphs.length,
					newParagraphCount: newParagraphs.length,
					oldOutputPath,
					newOutputPath,
				},
				null,
				2,
			)}\n`,
		);

		console.log(summaryPath);
		console.log(oldOutputPath);
		console.log(newOutputPath);
	} finally {
		await pdf.destroy();
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
