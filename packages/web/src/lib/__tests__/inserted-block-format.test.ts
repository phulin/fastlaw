import { describe, expect, it } from "vitest";
import { formatInsertedBlockContent } from "../inserted-block-format";

describe("formatInsertedBlockContent", () => {
	it("does not insert a space between adjacent marker tokens", () => {
		const formatted = formatInsertedBlockContent("(k)(3))) described", {
			baseDepth: 0,
			quotePlainMultiline: true,
		});
		expect(formatted).toBe("(k)(3))) described");
	});
});
