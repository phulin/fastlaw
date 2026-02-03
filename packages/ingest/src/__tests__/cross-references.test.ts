import { describe, expect, it } from "vitest";
import {
	extractSectionCrossReferences,
	type SectionCrossReference,
} from "../lib/cga/cross-references";

const findTarget = (
	references: SectionCrossReference[],
	section: string,
): SectionCrossReference | undefined =>
	references.find((ref) => ref.section === section);

describe("Section cross-reference grammar", () => {
	it("parses section lists with ranges", () => {
		const text =
			"Nothing in sections 1-1d, 3-94b to 3-94e, inclusive, 7-6 or 53a-87 shall impair.";
		const refs = extractSectionCrossReferences(text);

		const first = findTarget(refs, "1-1d");
		expect(first).toBeDefined();
		expect(first?.offset).toBe(text.indexOf("1-1d"));
		expect(first?.length).toBe("1-1d".length);
		expect(findTarget(refs, "3-94b")).toBeDefined();
		expect(findTarget(refs, "3-94e")).toBeDefined();
		expect(findTarget(refs, "7-6")).toBeDefined();
		expect(findTarget(refs, "53a-87")).toBeDefined();
	});

	it("parses qualifiers without leaking to subsequent sections", () => {
		const text =
			"Subsection (c) of section 7-66, section 7-83, 7-147h, subdivision (3), (5) or (6) of section 12-411.";
		const refs = extractSectionCrossReferences(text);

		expect(findTarget(refs, "7-83")).toBeDefined();
		expect(findTarget(refs, "7-147h")).toBeDefined();
		expect(findTarget(refs, "7-66")).toBeDefined();
		expect(findTarget(refs, "12-411")).toBeDefined();
	});

	it("parses nested qualifiers and ranges", () => {
		const text =
			"Serious juvenile offense includes 53a-54a to 53a-57, inclusive, subdivision (2) or (3) of subsection (a) of section 53-21 and subsection (a) of section 53a-174.";
		const refs = extractSectionCrossReferences(text);

		expect(findTarget(refs, "53a-54a")).toBeDefined();
		expect(findTarget(refs, "53a-57")).toBeDefined();
		expect(findTarget(refs, "53-21")).toBeDefined();
		expect(findTarget(refs, "53a-174")).toBeDefined();
	});

	it("handles missing spaces in lists", () => {
		const text = "Section 12-487,13a-26b, 13a-71 applies.";
		const refs = extractSectionCrossReferences(text);

		expect(findTarget(refs, "12-487")).toBeDefined();
		expect(findTarget(refs, "13a-26b")).toBeDefined();
		expect(findTarget(refs, "13a-71")).toBeDefined();
	});
});
