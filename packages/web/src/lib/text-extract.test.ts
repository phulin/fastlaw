import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { describe, expect, it } from "vitest";
import { extractParagraphs, PdfParagraphExtractor } from "./text-extract";

const makeTextItem = (
	str: string,
	x: number,
	y: number,
	width: number,
	height: number,
): TextItem => ({
	str,
	dir: "ltr",
	transform: [1, 0, 0, 1, x, y],
	width,
	height,
	fontName: "f1",
	hasEOL: false,
});

describe("extractParagraphs", () => {
	it("extracts text page-by-page from hr1-abridged fixture", async () => {
		const fixtureUrl = new URL("../../hr1-abridged.pdf", import.meta.url);
		const outputFixtureUrl = new URL(
			"./__fixtures__/hr1-abridged-output.txt",
			import.meta.url,
		);
		const data = new Uint8Array(await readFile(fixtureUrl));
		const expectedOutput = await readFile(outputFixtureUrl, "utf8");
		// @ts-expect-error - PDF.js runtime supports this option; types lag behind.
		const loadingTask = getDocument({ data, disableWorker: true });
		const pdf = await loadingTask.promise;

		try {
			const allParagraphs = await extractParagraphs(pdf);
			const paragraphsByPage: string[][] = Array.from(
				{ length: pdf.numPages },
				() => [],
			);
			for (const p of allParagraphs) {
				paragraphsByPage[p.startPage - 1].push(p.text);
			}

			expect(paragraphsByPage).toHaveLength(pdf.numPages);
			expect(allParagraphs.length).toBeGreaterThan(0);
			expect(
				paragraphsByPage[0]?.some(
					(paragraph) =>
						paragraph.includes("H.R. 1") && paragraph.includes("entitled"),
				),
			).toBe(true);

			const pageOutput = paragraphsByPage.map((paragraphs, index) => {
				const pageNumber = index + 1;
				const body =
					paragraphs.length > 0
						? paragraphs.map((paragraph) => `[*] ${paragraph}`).join("\n")
						: "[no paragraphs]";
				return `Page ${pageNumber}\n${body}`;
			});

			expect(`${pageOutput.join("\n\n")}\n`).toBe(expectedOutput);
		} finally {
			await pdf.destroy();
		}
	}, 120_000);

	it("drops centered top-of-page 1-4 digit spans", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			1,
			[
				makeTextItem("12", 300, 970, 10, 10),
				makeTextItem("Hello", 72, 820, 35, 10),
				makeTextItem("world", 115, 820, 36, 10),
			],
			612,
			1000,
		);

		const paragraphs = extractor.finish();
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe("Hello world");
	});

	it("drops bottom-of-page short dagger lines", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			1,
			[
				makeTextItem("†", 72, 80, 5, 10),
				makeTextItem("short", 84, 80, 25, 10),
				makeTextItem("footnote", 117, 80, 40, 10),
				makeTextItem("Body", 72, 700, 30, 10),
				makeTextItem("text", 108, 700, 28, 10),
			],
			612,
			1000,
		);

		const paragraphs = extractor.finish();
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe("Body text");
	});

	it("drops trailing hyphen when joined word exists in dictionary", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			1,
			[
				makeTextItem("infor-", 72, 700, 45, 10),
				makeTextItem("mation", 72, 685, 55, 10),
			],
			612,
			1000,
		);

		const paragraphs = extractor.finish();
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe("information");
	});

	it("keeps trailing hyphen when joined word is not in dictionary", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			1,
			[
				makeTextItem("state-", 72, 700, 42, 10),
				makeTextItem("owned", 72, 685, 46, 10),
			],
			612,
			1000,
		);

		const paragraphs = extractor.finish();
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe("state-owned");
	});
});
