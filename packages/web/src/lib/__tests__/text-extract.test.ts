import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { describe, expect, it } from "vitest";
import { extractParagraphs, PdfParagraphExtractor } from "../text-extract";

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
		const fixtureUrl = new URL("../../../hr1-abridged.pdf", import.meta.url);
		const outputFixtureUrl = new URL(
			"../__fixtures__/hr1-abridged-output.txt",
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

	it("keeps wrapped quoted continuation lines in the same paragraph when the continuation line starts with a marker", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			72,
			[
				makeTextItem(
					"“(D) UNBORN LIVESTOCK DEATH LOSSES",
					234,
					655.0001,
					251.98294,
					14,
				),
				makeTextItem(
					"DEFINED.—In this paragraph, the term ‘unborn",
					206,
					629.0001,
					280.0823,
					14,
				),
				makeTextItem(
					"livestock death losses’ means losses of any live-",
					205.9997,
					603.0007,
					280.0952,
					14,
				),
				makeTextItem(
					"stock described in subparagraph (A), (B), (D),",
					205.9997,
					577.0013,
					280.1624,
					14,
				),
				makeTextItem(
					"(E), (F), or (G) of subsection (a)(4) that was ges-",
					205.9997,
					551.0019,
					280.224,
					14,
				),
				makeTextItem(
					"tating on the date of the death of the livestock.”.",
					205.9997,
					525.0025,
					280.0686,
					14,
				),
				makeTextItem(
					"(b) LIVESTOCK FORAGE DISASTER PROGRAM.—Sec-",
					177.9997,
					499.0001,
					308.0961,
					14,
				),
				makeTextItem(
					"tion 1501(c)(3)(D)(ii)(I) of the Agricultural Act of 2014 (7",
					150.0006,
					473.0007,
					336.1764,
					14,
				),
				makeTextItem(
					"U.S.C. 9081(c)(3)(D)(ii)(I)) is amended—",
					150.0006,
					447.0013,
					238.3906,
					14,
				),
			],
			612,
			792,
		);

		const paragraphs = extractor.finish();
		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0]?.text).toBe(
			"“(D) UNBORN LIVESTOCK DEATH LOSSES DEFINED.—In this paragraph, the term ‘unborn livestock death losses’ means losses of any livestock described in subparagraph (A), (B), (D), (E), (F), or (G) of subsection (a)(4) that was gestating on the date of the death of the livestock.”.",
		);
		expect(paragraphs[1]?.text).toBe(
			"(b) LIVESTOCK FORAGE DISASTER PROGRAM.—Section 1501(c)(3)(D)(ii)(I) of the Agricultural Act of 2014 (7 U.S.C. 9081(c)(3)(D)(ii)(I)) is amended—",
		);
	});

	it("coalesces wrapped quoted text when the next line begins with a parenthetical list token inside the sentence", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			92,
			[
				makeTextItem(
					"“(e) MANDATORY FUNDING.—Subject to subsections",
					178,
					629.0001,
					307.99980000000005,
					14.0017,
				),
				makeTextItem(
					"(b), (c), and (d), of the funds of the Commodity Credit Cor-",
					149.9998,
					603.0007,
					353.2788,
					14,
				),
				makeTextItem(
					"poration, the Secretary shall make available to carry out",
					149.9998,
					577.0013,
					353.0562,
					14,
				),
				makeTextItem(
					"the competitive grant program under section 4",
					149.9998,
					551.0019,
					353.0646,
					14,
				),
				makeTextItem(
					"$125,000,000 for fiscal year 2026 and each fiscal year there-",
					149.9998,
					525.0025,
					353.2004,
					14,
				),
				makeTextItem("after.”.", 149.9998, 499.0031, 39.45199999999999, 14),
			],
			612,
			792,
		);

		const paragraphs = extractor.finish();
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0]?.text).toBe(
			"“(e) MANDATORY FUNDING.—Subject to subsections (b), (c), and (d), of the funds of the Commodity Credit Corporation, the Secretary shall make available to carry out the competitive grant program under section 4 $125,000,000 for fiscal year 2026 and each fiscal year thereafter.”.",
		);
	});

	it("splits SHEEP PRODUCTION amendment from following subsection heading on HR 1 page 96 line geometry", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			96,
			[
				makeTextItem("14", 125.9994, 369.0013, 14, 14),
				makeTextItem(
					"(1) by striking ‘‘2019, and’’ and inserting",
					205.9996,
					369.0013,
					280.0784,
					14,
				),
				makeTextItem("15", 125.9994, 343.0019, 14, 14),
				makeTextItem("‘‘2019,’’; and", 177.9996, 343.0019, 73.192, 14),
				makeTextItem("16", 125.9994, 317.0025, 14, 14),
				makeTextItem(
					"(2) by inserting ‘‘and $3,000,000 for fiscal year",
					205.9996,
					317.0025,
					280.1288,
					14,
				),
				makeTextItem("17", 125.9994, 291.0031, 14, 14),
				makeTextItem(
					"2026,’’ after ‘‘fiscal year 2024,’’",
					177.9996,
					291.0031,
					179.354,
					14,
				),
				makeTextItem("18", 126.0003, 265.0001, 14, 14),
				makeTextItem(
					"(c) PIMA AGRICULTURE COTTON TRUST FUND.—Sec-",
					177.9996,
					265.0037,
					308.0037,
					14,
				),
			],
			612,
			792,
		);

		const paragraphs = extractor.finish();
		const paragraphWithSecondAmendment = paragraphs.find((paragraph) =>
			paragraph.text.includes("(2) by inserting"),
		);
		const paragraphWithPimaHeading = paragraphs.find((paragraph) =>
			paragraph.text.includes("PIMA AGRICULTURE COTTON TRUST FUND"),
		);

		expect(paragraphWithSecondAmendment).toBeDefined();
		expect(paragraphWithSecondAmendment?.text).not.toContain(
			"PIMA AGRICULTURE COTTON TRUST FUND",
		);
		expect(paragraphWithPimaHeading?.text.startsWith("(c) PIMA")).toBe(true);
	});

	it("coalesces wrapped redesignation lines with a line-number column when the first line ends with 'and'", () => {
		const extractor = new PdfParagraphExtractor();
		const fixtureLines = [
			{
				lineNumber: "1",
				text: "‘‘(2) the prevailing world market price for the",
				y: 707,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 206,
				textWidth: 280.1805999999999,
			},
			{
				lineNumber: "2",
				text: "commodity, as determined and adjusted by the Sec-",
				y: 681.0006,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 178,
				textWidth: 308.06860000000006,
			},
			{
				lineNumber: "3",
				text: "retary in accordance with this section.’’;",
				y: 655.0012,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 178,
				textWidth: 227.94800000000004,
			},
			{
				lineNumber: "4",
				text: "(3) in subsection (d)—",
				y: 629.0018,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 206,
				textWidth: 129.30399999999997,
			},
			{
				lineNumber: "5",
				text: "(A) in paragraph (1), by striking ‘‘and me-",
				y: 603.0024,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 234,
				textWidth: 252.14140000000017,
			},
			{
				lineNumber: "6",
				text: "dium grain rice’’ and inserting ‘‘medium grain",
				y: 577.003,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 206,
				textWidth: 280.0644,
			},
			{
				lineNumber: "7",
				text: "rice, and extra long staple cotton’’;",
				y: 551.0036,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 206,
				textWidth: 196.77000000000004,
			},
			{
				lineNumber: "8",
				text: "(B) by redesignating paragraphs (1) and",
				y: 525.0042,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 234,
				textWidth: 252.09800000000013,
			},
			{
				lineNumber: "9",
				text: "(2) as subparagraphs (A) and (B), respectively,",
				y: 499.0048,
				lineNumberX: 132.9998,
				lineNumberWidth: 7,
				textX: 206,
				textWidth: 280.126,
			},
			{
				lineNumber: "10",
				text: "and indenting appropriately;",
				y: 473.0054,
				lineNumberX: 125.9998,
				lineNumberWidth: 14,
				textX: 206,
				textWidth: 166.264,
			},
			{
				lineNumber: "11",
				text: "(C) in the matter preceding subparagraph",
				y: 447.006,
				lineNumberX: 125.9998,
				lineNumberWidth: 14,
				textX: 234,
				textWidth: 252.08399999999995,
			},
		];

		extractor.ingestPage(
			53,
			fixtureLines.flatMap((line) => [
				makeTextItem(
					line.lineNumber,
					line.lineNumberX,
					line.y,
					line.lineNumberWidth,
					14,
				),
				makeTextItem(line.text, line.textX, line.y, line.textWidth, 14),
			]),
			612,
			792,
		);

		const paragraphs = extractor.finish();
		const redesignationParagraph = paragraphs.find((paragraph) =>
			paragraph.text.startsWith("(B) by redesignating paragraphs (1) and"),
		);
		expect(redesignationParagraph?.text).toBe(
			"(B) by redesignating paragraphs (1) and (2) as subparagraphs (A) and (B), respectively, and indenting appropriately;",
		);
	});

	it("inserts missing space when a closing quote is immediately followed by a word in a single span", () => {
		const extractor = new PdfParagraphExtractor();
		extractor.ingestPage(
			96,
			[
				makeTextItem("20", 126.0003, 213.0013, 14, 14),
				makeTextItem(
					"note; Public Law 113–79) is amended—",
					177.9996,
					213.0013,
					196.9042,
					14,
				),
				makeTextItem("21", 126.0003, 187.0019, 14, 14),
				makeTextItem(
					"(1) in subsection (b), in the matter preceding",
					177.9996,
					187.0019,
					252.0947,
					14,
				),
				makeTextItem("22", 126.0003, 161.0025, 14, 14),
				makeTextItem(
					"paragraph (1), by striking ‘‘2024’’ and inserting",
					177.9996,
					161.0025,
					252.1213,
					14,
				),
				makeTextItem("23", 126.0003, 135.0031, 14, 14),
				makeTextItem("‘‘2031’’; and", 177.9996, 135.0031, 69.8189, 14),
				makeTextItem("24", 126.0003, 109.0037, 14, 14),
				makeTextItem(
					"(2) in subsection (h), by striking ‘‘2024’’and in-",
					206.0005,
					109.0037,
					280.126,
					14,
				),
				makeTextItem("25", 126.0003, 83.0043, 14, 14),
				makeTextItem("serting ‘‘2031’’.", 177.9997, 83.0043, 86.7308, 14),
			],
			612,
			792,
		);

		const paragraphs = extractor.finish();
		const targetParagraph = paragraphs.find((paragraph) =>
			paragraph.text.includes("(2) in subsection (h), by striking"),
		);
		expect(targetParagraph).toBeDefined();
		expect(targetParagraph?.text).toContain(
			"(2) in subsection (h), by striking “2024” and inserting “2031”.",
		);
		expect(targetParagraph?.text).not.toContain("”and");
	});
});
