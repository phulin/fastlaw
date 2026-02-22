import { describe, expect, it } from "vitest";
import { ScopeKind, type TargetScopeSegment } from "../amendment-edit-tree";
import type { Paragraph } from "../types";
import {
	discoverParsedInstructionSpans,
	discoverTitleScopedCodeReferenceDefaults,
	getUscSectionPathFromScopePath,
} from "./instruction-utils";

describe("getUscSectionPathFromScopePath", () => {
	it("normalizes en dash in section number before creating section path", () => {
		const targetScopePath: TargetScopeSegment[] = [
			{ kind: "code_reference", label: "7 U.S.C." },
			{ kind: ScopeKind.Section, label: "1308–1" },
		];

		expect(getUscSectionPathFromScopePath(targetScopePath)).toBe(
			"/statutes/usc/section/7/1308-1",
		);
	});

	it("keeps existing hyphenated section numbers unchanged", () => {
		const targetScopePath: TargetScopeSegment[] = [
			{ kind: "code_reference", label: "7 U.S.C." },
			{ kind: ScopeKind.Section, label: "1308-1" },
		];

		expect(getUscSectionPathFromScopePath(targetScopePath)).toBe(
			"/statutes/usc/section/7/1308-1",
		);
	});
});

const makeParagraph = (text: string): Paragraph => ({
	startPage: 1,
	endPage: 1,
	text,
	lines: [],
	confidence: 0.6,
	y: 0,
	yStart: 0,
	yEnd: 0,
	pageHeight: 1,
	isBold: false,
	level: 0,
});

describe("discoverParsedInstructionSpans", () => {
	it("attaches SEC heading as bill section for following instruction", () => {
		const paragraphs = [
			makeParagraph("SEC. 101. SNAP CHANGES."),
			makeParagraph(
				"Section 3 of title 7, United States Code, is amended by striking “A” and inserting “B”.",
			),
		];

		const spans = discoverParsedInstructionSpans(paragraphs);

		expect(spans.length).toBe(1);
		expect(spans[0]?.billSection).toBe("SEC. 101. SNAP CHANGES.");
	});

	it("falls back to higher-level title heading when no SEC heading exists", () => {
		const paragraphs = [
			makeParagraph("TITLE I—AGRICULTURE"),
			makeParagraph(
				"Section 4 of title 7, United States Code, is amended by striking “A” and inserting “B”.",
			),
		];

		const spans = discoverParsedInstructionSpans(paragraphs);

		expect(spans.length).toBe(1);
		expect(spans[0]?.billSection).toBe("TITLE I—AGRICULTURE");
	});
});

describe("discoverTitleScopedCodeReferenceDefaults", () => {
	it("maps title-wide Internal Revenue Code references to 26 U.S.C.", () => {
		const paragraphs = [
			makeParagraph("TITLE VII—FINANCE"),
			makeParagraph(
				"(a) REFERENCES.—Except as otherwise expressly provided, whenever in this title, an amendment or repeal is expressed in terms of an amendment to, or repeal of, a section or other provision, the reference shall be considered to be made to a section or other provision of the Internal Revenue Code of 1986.",
			),
			makeParagraph("SEC. 70002. SOME CHANGE."),
			makeParagraph("Section 45D(a) is amended by striking “A”."),
		];

		const defaults = discoverTitleScopedCodeReferenceDefaults(paragraphs);

		expect(defaults.get(3)).toBe("26 U.S.C.");
	});

	it("does not leak defaults into later titles without their own rule", () => {
		const paragraphs = [
			makeParagraph("TITLE VII—FINANCE"),
			makeParagraph(
				"(a) REFERENCES.—Except as otherwise expressly provided, whenever in this title, an amendment or repeal is expressed in terms of an amendment to, or repeal of, a section or other provision, the reference shall be considered to be made to a section or other provision of the Internal Revenue Code of 1986.",
			),
			makeParagraph("TITLE VIII—OTHER"),
			makeParagraph("Section 45D(a) is amended by striking “A”."),
		];

		const defaults = discoverTitleScopedCodeReferenceDefaults(paragraphs);

		expect(defaults.has(3)).toBe(false);
	});
});
