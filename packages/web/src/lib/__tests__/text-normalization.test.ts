import { describe, expect, it } from "vitest";
import { normalizeFractionSlashFractions } from "../text-normalization";

describe("normalizeFractionSlashFractions", () => {
	it("normalizes simple U+2044 fractions when a single Unicode fraction exists", () => {
		expect(normalizeFractionSlashFractions("1⁄2 and 3⁄4 and 2⁄7")).toBe(
			"½ and ¾ and 2⁄7",
		);
	});

	it("normalizes mixed-number forms like 121⁄2 into 12½", () => {
		expect(normalizeFractionSlashFractions("121⁄2 per centum")).toBe(
			"12½ per centum",
		);
	});

	it("leaves non-mappable fraction slash forms unchanged", () => {
		expect(normalizeFractionSlashFractions("123⁄11 42⁄19")).toBe(
			"123⁄11 42⁄19",
		);
	});
});
