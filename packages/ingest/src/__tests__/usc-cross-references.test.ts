import { describe, expect, it } from "vitest";
import {
	extractSectionCrossReferences,
	type SectionCrossReference,
} from "../lib/usc/cross-references";

const findTarget = (
	references: SectionCrossReference[],
	section: string,
	titleNum: string,
): SectionCrossReference | undefined =>
	references.find(
		(ref) => ref.section === section && ref.titleNum === titleNum,
	);

describe("USC cross-reference grammar", () => {
	it("parses title-based references", () => {
		const text = "See 42 U.S.C. 1983 and 18 U.S.C. 1001.";
		const refs = extractSectionCrossReferences(text, "42");

		const first = findTarget(refs, "1983", "42");
		expect(first).toBeDefined();
		expect(first?.offset).toBe(text.indexOf("1983"));
		expect(first?.length).toBe("1983".length);
		expect(findTarget(refs, "1001", "18")).toBeDefined();
	});

	it("parses relative sections with explicit title", () => {
		const text = "Section 552 of title 5 applies.";
		const refs = extractSectionCrossReferences(text, "1");

		const ref = findTarget(refs, "552", "5");
		expect(ref).toBeDefined();
		expect(ref?.offset).toBe(text.indexOf("552"));
	});

	it("parses ranges with default title", () => {
		const text = "Sections 101 to 103, inclusive, are reserved.";
		const refs = extractSectionCrossReferences(text, "12");

		expect(findTarget(refs, "101", "12")).toBeDefined();
		expect(findTarget(refs, "103", "12")).toBeDefined();
	});
});
