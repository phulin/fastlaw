import { describe, expect, it } from "vitest";
import {
	getReleasePointFromTitleUrls,
	getReleasePointFromUrl,
	getTitleNumFromUrl,
} from "../lib/usc/fetcher";

describe("USC fetcher URL parsing", () => {
	it("extracts title number from house XML URL", () => {
		expect(
			getTitleNumFromUrl(
				"https://uscode.house.gov/download/releasepoints/us/pl/119/73/xml_usc42@119-73not60.zip",
			),
		).toBe("42");
	});

	it("extracts release point from house XML URL", () => {
		expect(
			getReleasePointFromUrl(
				"https://uscode.house.gov/download/releasepoints/us/pl/119/73/xml_usc42@119-73not60.zip",
			),
		).toBe("119-73not60");
	});

	it("extracts release point with non-standard suffix formats", () => {
		expect(
			getReleasePointFromUrl(
				"https://uscode.house.gov/download/releasepoints/us/pl/119/73/xml_usc42@119-73revA_1.zip",
			),
		).toBe("119-73revA_1");
	});

	it("returns null release point when URL does not contain one", () => {
		expect(getReleasePointFromUrl("https://example.com/usc42.xml")).toBe(null);
	});

	it("returns single release point across title URLs", () => {
		expect(
			getReleasePointFromTitleUrls([
				"https://uscode.house.gov/download/releasepoints/us/pl/119/73/xml_usc01@119-73not60.zip",
				"https://uscode.house.gov/download/releasepoints/us/pl/119/73/xml_usc42@119-73not60.zip",
			]),
		).toBe("119-73not60");
	});

	it("throws when title URLs include multiple release points", () => {
		expect(() =>
			getReleasePointFromTitleUrls([
				"https://uscode.house.gov/download/releasepoints/us/pl/119/72/xml_usc01@119-72.zip",
				"https://uscode.house.gov/download/releasepoints/us/pl/119/73/xml_usc42@119-73not60.zip",
			]),
		).toThrow("multiple USC release points");
	});
});
