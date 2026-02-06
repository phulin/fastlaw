import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseXmlWithHandler } from "../lib/sax-parser";
import { parseUSCXml, USC_LEVEL_INDEX } from "../lib/usc/parser";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(__dirname, "fixtures");
const dataDir = join(__dirname, "..", "..", "..", "..", "data");

function loadFixture(filename: string): string {
	return readFileSync(join(fixturesDir, filename), "utf-8");
}

function loadDataFixture(filename: string): string {
	return readFileSync(join(dataDir, filename), "utf-8");
}

function normalizeTextContent(text: string): string {
	const normalized = text.replace(/[\u00a0\u202f]/g, " ");
	return normalized.replace(/\s+/g, " ").trim();
}

function stripLeadingZeros(value: string): string {
	const match = value.match(/^0*([0-9]+)([a-z]*)$/i);
	if (!match) return value;
	const num = String(Number.parseInt(match[1], 10));
	const suffix = match[2].toLowerCase();
	return `${num}${suffix}`;
}

function normalizeTagName(tagName: string): string {
	const colonIndex = tagName.indexOf(":");
	if (colonIndex !== -1) {
		return tagName.substring(colonIndex + 1);
	}
	return tagName;
}

function getAttr(
	attrs: { name: string; value: string }[],
	name: string,
): string | undefined {
	const attr = attrs.find((a) => a.name === name);
	return attr?.value;
}

async function extractOuterSectionTextContent(
	xml: string,
): Promise<Map<string, { actual: string; expected: string }>> {
	const SECTION_BODY_TAGS = new Set([
		"content",
		"chapeau",
		"p",
		"subsection",
		"paragraph",
		"subparagraph",
		"clause",
		"subclause",
		"item",
		"subitem",
	]);
	const joinPartsWithSpacing = (parts: string[]): string => {
		let result = "";
		for (const part of parts) {
			if (!result) {
				result = part;
				continue;
			}
			if (
				part &&
				!/\s$/.test(result) &&
				!/^\s/.test(part) &&
				!/^[,.;:)\]"'“”‘’]/.test(part) &&
				!/[—-]$/.test(result) &&
				!/[[(]$/.test(result) &&
				!(/\)$/.test(result) && /^\(/.test(part)) &&
				!(
					/\d$/.test(result) &&
					/^[A-Za-z]/.test(part) &&
					part.trim().length === 1
				)
			) {
				result += ` ${part}`;
			} else {
				result += part;
			}
		}
		return result;
	};

	type NoteFrame = {
		topic: string;
		role: string;
		headingText: string;
		headingBuffer: string;
		pParts: string[];
		pBuffer: string;
		rawParts: string[];
	};

	type SectionFrame = {
		sectionNum: string | null;
		heading: string;
		headingBuffer: string;
		bodyParts: string[];
		bodyBuffer: string;
		notesParts: string[];
		rawTextParts: string[];
		note: NoteFrame | null;
	};

	const results = new Map<string, { actual: string; expected: string }>();

	let sectionDepth = 0;
	let noteDepth = 0;
	let sourceCreditDepth = 0;
	const tagStack: string[] = [];

	let sectionHeadingDepth = 0;
	let bodyCaptureDepth = 0;
	let noteHeadingDepth = 0;
	let notePDepth = 0;
	let noteNameDepth = 0;

	let current: SectionFrame | null = null;

	await parseXmlWithHandler(xml, (event) => {
		if (event.type === "openTag") {
			const tagName = normalizeTagName(event.tag.name);
			const attrs = event.tag.attributes;
			tagStack.push(tagName);

			if (tagName === "section") {
				if (sectionDepth === 0 && noteDepth === 0) {
					current = {
						sectionNum: null,
						heading: "",
						headingBuffer: "",
						bodyParts: [],
						bodyBuffer: "",
						notesParts: [],
						rawTextParts: [],
						note: null,
					};
				}
				sectionDepth += 1;
			}

			if (!current) {
				if (tagName === "note") {
					noteDepth += 1;
				}
				if (tagName === "sourceCredit") {
					sourceCreditDepth += 1;
				}
				return;
			}

			if (tagName === "note") {
				noteDepth += 1;
				if (noteDepth === 1) {
					current.note = {
						topic: getAttr(attrs, "topic") ?? "",
						role: getAttr(attrs, "role") ?? "",
						headingText: "",
						headingBuffer: "",
						pParts: [],
						pBuffer: "",
						rawParts: [],
					};
				}
			}

			if (tagName === "sourceCredit") {
				sourceCreditDepth += 1;
			}

			if (noteDepth === 0 && sourceCreditDepth === 0) {
				if (tagName === "num" && !current.sectionNum) {
					const value = getAttr(attrs, "value");
					if (value) {
						current.sectionNum = stripLeadingZeros(value);
					}
				}

				if (tagName === "heading" && tagStack.at(-2) === "section") {
					sectionHeadingDepth += 1;
					if (sectionHeadingDepth === 1) {
						current.headingBuffer = "";
					}
				}

				if (SECTION_BODY_TAGS.has(tagName)) {
					bodyCaptureDepth += 1;
					if (bodyCaptureDepth === 1) {
						current.bodyBuffer = "";
					}
				}
			}

			if (current.note && noteDepth > 0) {
				if (tagName === "heading") {
					if (!current.note.headingText && !current.note.headingBuffer) {
						noteHeadingDepth += 1;
						if (noteHeadingDepth === 1) {
							current.note.headingBuffer = "";
						}
					}
				}
				if (tagName === "p") {
					notePDepth += 1;
					if (notePDepth === 1) {
						current.note.pBuffer = "";
					}
				}
				if (tagName === "name") {
					noteNameDepth += 1;
					if (noteNameDepth === 1) {
						current.note.pBuffer = "";
					}
				}
			}
		}

		if (event.type === "text" && current) {
			const textValue = event.text.value;
			if (sourceCreditDepth === 0) {
				if (noteDepth === 0) {
					current.rawTextParts.push(textValue);
				} else if (current.note) {
					current.note.rawParts.push(textValue);
				}
			}

			if (noteDepth === 0 && sourceCreditDepth === 0) {
				if (sectionHeadingDepth > 0) {
					current.headingBuffer += textValue;
				}
				if (bodyCaptureDepth > 0) {
					current.bodyBuffer += textValue;
				}
			}

			if (current.note && noteDepth > 0) {
				if (noteHeadingDepth > 0) {
					current.note.headingBuffer += textValue;
				}
				if (notePDepth > 0 || noteNameDepth > 0) {
					current.note.pBuffer += textValue;
				}
			}
		}

		if (event.type === "closeTag") {
			const tagName = normalizeTagName(event.tag.name);

			if (current) {
				if (tagName === "heading" && sectionHeadingDepth > 0) {
					sectionHeadingDepth -= 1;
					if (sectionHeadingDepth === 0) {
						current.heading = normalizeTextContent(current.headingBuffer);
					}
				}

				if (
					noteDepth === 0 &&
					sourceCreditDepth === 0 &&
					SECTION_BODY_TAGS.has(tagName)
				) {
					bodyCaptureDepth -= 1;
					if (bodyCaptureDepth === 0) {
						const text = current.bodyBuffer.trim();
						if (text) {
							current.bodyParts.push(text);
						}
						current.bodyBuffer = "";
					}
				}

				if (current.note && tagName === "heading" && noteHeadingDepth > 0) {
					noteHeadingDepth -= 1;
					if (noteHeadingDepth === 0) {
						current.note.headingText = normalizeTextContent(
							current.note.headingBuffer,
						);
					}
				}

				if (current.note && tagName === "p" && notePDepth > 0) {
					notePDepth -= 1;
					if (notePDepth === 0) {
						const text = normalizeTextContent(current.note.pBuffer);
						if (text) {
							current.note.pParts.push(text);
						}
						current.note.pBuffer = "";
					}
				}
				if (current.note && tagName === "name" && noteNameDepth > 0) {
					noteNameDepth -= 1;
					if (noteNameDepth === 0) {
						const text = normalizeTextContent(current.note.pBuffer);
						if (text) {
							current.note.pParts.push(text);
						}
						current.note.pBuffer = "";
					}
				}

				if (tagName === "note" && current.note && noteDepth === 1) {
					const heading = current.note.headingText;
					const body = normalizeTextContent(current.note.pParts.join("\n\n"));
					const finalBody = body || heading;

					const isAmendments =
						current.note.topic === "amendments" ||
						heading.toLowerCase().includes("amendments");
					const isCrossHeading =
						current.note.role.includes("crossHeading") ||
						heading.includes("Editorial") ||
						heading.includes("Statutory");

					if (finalBody && !isCrossHeading) {
						const noteText = heading ? `${heading}\n${finalBody}` : finalBody;
						if (isAmendments) {
							current.notesParts.push(noteText);
						} else {
							current.notesParts.push(noteText);
						}
						let rawNote = joinPartsWithSpacing(current.note.rawParts);
						rawNote = rawNote.trimStart();
						if (heading && rawNote.startsWith(heading)) {
							const afterHeading = rawNote.slice(heading.length);
							if (!afterHeading.startsWith(" ")) {
								rawNote = `${heading} ${afterHeading}`.trim();
							}
						}
						const prev = current.rawTextParts.at(-1);
						if (prev && !/\s$/.test(prev) && rawNote && !/^\s/.test(rawNote)) {
							rawNote = ` ${rawNote}`;
						}
						current.rawTextParts.push(rawNote);
					}

					current.note = null;
				}
			}

			if (tagName === "note") {
				noteDepth -= 1;
			}

			if (tagName === "sourceCredit") {
				sourceCreditDepth -= 1;
			}

			if (tagName === "section") {
				sectionDepth -= 1;
				if (sectionDepth === 0 && current?.sectionNum) {
					const header = `§ ${current.sectionNum}. ${current.heading}`;
					const content = normalizeTextContent(
						joinPartsWithSpacing(current.bodyParts),
					);
					const notes = normalizeTextContent(
						joinPartsWithSpacing(current.notesParts),
					);
					const expected = normalizeTextContent(
						[header, content, notes].filter(Boolean).join("\n\n"),
					);
					let actual = normalizeTextContent(
						joinPartsWithSpacing(current.rawTextParts),
					);
					if (actual.startsWith(header) && !actual.startsWith(`${header} `)) {
						actual = `${header} ${actual.slice(header.length)}`.trim();
					}
					results.set(current.sectionNum, { actual, expected });
					current = null;
				}
			}
			tagStack.pop();
		}
	});

	return results;
}

describe("USC Parser - Title 1", () => {
	const xml = loadFixture("usc_title_1.xml");

	it("extracts correct title number", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		expect(result.titleNum).toBe("1");
	});

	it("extracts title name", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		expect(result.titleName).toBe("Title 1");
	});

	it("extracts chapters as organizational levels", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		expect(result.levels.length).toBeGreaterThan(0);
		const chapters = result.levels.filter((l) => l.levelType === "chapter");
		expect(chapters.length).toBe(3);
	});

	it("assigns correct level indices", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		for (const level of result.levels) {
			expect(level.levelIndex).toBe(USC_LEVEL_INDEX[level.levelType]);
		}
	});

	it("extracts sections", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		expect(result.sections.length).toBeGreaterThan(0);
		// Title 1 has around 39 sections
		expect(result.sections.length).toBeGreaterThanOrEqual(35);
	});

	it("extracts section numbers correctly", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		const sectionNums = result.sections.map((s) => s.sectionNum);
		// Title 1 starts with section 1
		expect(sectionNums).toContain("1");
		// Should have sequential sections
		expect(sectionNums).toContain("2");
		expect(sectionNums).toContain("3");
	});

	it("extracts section 1 with correct structure", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		const section1 = result.sections.find((s) => s.sectionNum === "1");
		if (!section1) {
			throw new Error("Section 1 not found");
		}

		// Body content
		expect(section1.body.length).toBeGreaterThan(100);
		expect(section1.body).toContain("meaning");

		// Paths and IDs
		expect(section1.path).toBe("/statutes/usc/section/1/1");
		expect(section1.docId).toBe("doc_usc_1-1");
		expect(section1.sectionKey).toBe("1:1");

		// Parent linkage (sections in chapter 1 should have chapter parent)
		expect(section1.parentRef.kind).toBe("level");
		if (section1.parentRef.kind === "level") {
			expect(section1.parentRef.levelType).toBe("chapter");
		}
	});

	it("extracts section 201 heading from the section header", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		const section201 = result.sections.find((s) => s.sectionNum === "201");
		if (!section201) {
			throw new Error("Section 201 not found");
		}
		expect(section201.heading).toBe(
			"Publication and distribution of Code of Laws of United States and Supplements and District of Columbia Code and Supplements",
		);
		expect(section201.body).toContain(
			"**Publishing in slip or pamphlet form or in Statutes at Large.—**",
		);
	});

	it("extracts source credit as historyShort", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		// At least some sections should have source credits
		const sectionsWithHistory = result.sections.filter(
			(s) => s.historyShort.length > 0,
		);
		expect(sectionsWithHistory.length).toBeGreaterThan(0);
	});

	it("sets chapter identifiers correctly", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		const chapter1 = result.levels.find(
			(l) => l.levelType === "chapter" && l.num === "1",
		);
		if (!chapter1) {
			throw new Error("Chapter 1 not found");
		}
		expect(chapter1.identifier).toBe("1-ch1");
		expect(chapter1.titleNum).toBe("1");
	});

	it("links chapters to title as parent", async () => {
		const result = await parseUSCXml(xml, "1", "https://uscode.house.gov/");
		for (const level of result.levels) {
			if (level.levelType === "chapter") {
				expect(level.parentIdentifier).toBe("1-title");
			}
		}
	});

	it("matches outer section textContent to the expected format", async () => {
		const sectionText = await extractOuterSectionTextContent(xml);
		expect(sectionText.size).toBeGreaterThan(0);
		for (const [sectionNum, { actual, expected }] of sectionText) {
			const normalizedActual = actual.replace(/\s+/g, "").trim();
			const normalizedExpected = expected.replace(/\s+/g, "").trim();
			if (normalizedActual !== normalizedExpected) {
				const min = Math.min(
					normalizedActual.length,
					normalizedExpected.length,
				);
				let idx = 0;
				while (idx < min && normalizedActual[idx] === normalizedExpected[idx]) {
					idx += 1;
				}
				const contextStart = Math.max(0, idx - 40);
				const contextEnd = idx + 120;
				throw new Error(
					[
						`Section ${sectionNum} mismatch at ${idx}:`,
						`expected: ${normalizedExpected.slice(contextStart, contextEnd)}`,
						`actual:   ${normalizedActual.slice(contextStart, contextEnd)}`,
					].join("\n"),
				);
			}
			expect(actual.startsWith(`§ ${sectionNum}. `)).toBe(true);
		}
	});
});

describe("USC Parser - Edge Cases", () => {
	it("returns empty results for invalid XML", async () => {
		const result = await parseUSCXml("<invalid>not usc xml</invalid>", "1", "");
		expect(result.sections).toEqual([]);
		expect(result.levels).toEqual([]);
	});

	it("handles XML with no sections", async () => {
		const minimalXml = `<?xml version="1.0"?>
			<uscDoc xmlns="http://xml.house.gov/schemas/uslm/1.0" identifier="/us/usc/t99">
				<meta><title>Title 99</title></meta>
				<main><title identifier="/us/usc/t99"></title></main>
			</uscDoc>`;
		const result = await parseUSCXml(minimalXml, "99", "");
		expect(result.sections).toEqual([]);
		expect(result.titleNum).toBe("99");
	});
});

describe("USC Parser - Repealed Brackets", () => {
	const xml = loadDataFixture("usc_mirror/usc03.xml");

	it("drops trailing bracket on repealed chapter heading", async () => {
		const result = await parseUSCXml(xml, "3", "https://uscode.house.gov/");
		const chapter3 = result.levels.find(
			(level) => level.levelType === "chapter" && level.num === "3",
		);
		if (!chapter3) {
			throw new Error("Chapter 3 not found");
		}
		expect(chapter3.heading).toBe("REPEALED");
	});

	it("drops trailing bracket on repealed section heading", async () => {
		const result = await parseUSCXml(xml, "3", "https://uscode.house.gov/");
		const section2 = result.sections.find(
			(section) => section.sectionNum === "2",
		);
		if (!section2) {
			throw new Error("Section 2 not found");
		}
		expect(section2.heading).toBe(
			"Repealed. Pub. L. 117–328, div. P, title I, § 102(a), Dec. 29, 2022, 136 Stat. 5233",
		);
	});
});
