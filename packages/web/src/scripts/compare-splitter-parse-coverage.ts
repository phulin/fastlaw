import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAmendmentGrammarParser } from "./create-amendment-grammar-parser";

const AMENDATORY_START_RE = /\bis (?:further )?amended\b/i;
const HIGHER_DIVISION_USC_RE =
	/(?:Title|Subtitle|Chapter|Subchapter|Part|Subpart|Division|Book)\s+[A-Za-z0-9().-]+\s+of /;
const ANALYSIS_FOR_RE =
	/\bThe analysis for\b|\bThe table of (subtitles|parts|subparts|chapters|subchapters|sections) for\b|\bThe item relating to\b/;

interface ParagraphLike {
	text: string;
}

interface CoverageSummary {
	paragraphCount: number;
	parseStartCount: number;
	matchedCount: number;
	parsedParagraphCount: number;
	unparsedParagraphCount: number;
}

function parseParagraphFile(raw: string): ParagraphLike[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const stripped = line.replace(/^\(p\d+-\d+\)\s*/, "");
			return { text: stripped };
		});
}

async function evaluateCoverage(
	paragraphs: ParagraphLike[],
): Promise<CoverageSummary> {
	const parser = await createAmendmentGrammarParser();
	const maxParagraphsToTry = 120;

	let scanIndex = 0;
	let parseStartCount = 0;
	let matchedCount = 0;
	let parsedParagraphCount = 0;

	while (scanIndex < paragraphs.length) {
		const startParagraph = paragraphs[scanIndex];
		if (!startParagraph) break;
		if (!AMENDATORY_START_RE.test(startParagraph.text)) {
			scanIndex += 1;
			continue;
		}
		if (HIGHER_DIVISION_USC_RE.test(startParagraph.text)) {
			scanIndex += 1;
			continue;
		}
		if (ANALYSIS_FOR_RE.test(startParagraph.text)) {
			scanIndex += 1;
			continue;
		}

		parseStartCount += 1;
		let sequenceText = "";
		let bestMatchEndParagraphIndex = -1;

		for (
			let endParagraphIndex = scanIndex;
			endParagraphIndex < paragraphs.length &&
			endParagraphIndex - scanIndex + 1 <= maxParagraphsToTry;
			endParagraphIndex++
		) {
			const paragraph = paragraphs[endParagraphIndex];
			if (!paragraph) break;
			sequenceText =
				sequenceText.length === 0
					? paragraph.text
					: `${sequenceText}\n${paragraph.text}`;

			const parseResult = parser.parse(sequenceText);
			if (parseResult.ok) {
				bestMatchEndParagraphIndex = endParagraphIndex;
				continue;
			}
			if (bestMatchEndParagraphIndex !== -1) break;
		}

		if (bestMatchEndParagraphIndex !== -1) {
			matchedCount += 1;
			parsedParagraphCount += bestMatchEndParagraphIndex - scanIndex + 1;
			scanIndex = bestMatchEndParagraphIndex + 1;
			continue;
		}

		scanIndex += 1;
	}

	return {
		paragraphCount: paragraphs.length,
		parseStartCount,
		matchedCount,
		parsedParagraphCount,
		unparsedParagraphCount: paragraphs.length - parsedParagraphCount,
	};
}

async function main(): Promise<void> {
	const oldPath = resolve("packages/web/tmp/bills-119hr1eas-old-splitter.txt");
	const newPath = resolve("packages/web/tmp/bills-119hr1eas-new-splitter.txt");
	const [oldRaw, newRaw] = await Promise.all([
		readFile(oldPath, "utf8"),
		readFile(newPath, "utf8"),
	]);

	const oldParagraphs = parseParagraphFile(oldRaw);
	const newParagraphs = parseParagraphFile(newRaw);
	const [oldCoverage, newCoverage] = await Promise.all([
		evaluateCoverage(oldParagraphs),
		evaluateCoverage(newParagraphs),
	]);

	console.log(JSON.stringify({ oldCoverage, newCoverage }, null, 2));
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
