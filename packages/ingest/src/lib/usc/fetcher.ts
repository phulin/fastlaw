/**
 * USC XML fetcher
 *
 * Downloads USC XML files from the House OLRC website.
 * The full code is available as individual XML files per title.
 *
 * Note: The ZIP download approach requires unzipping which is complex in Workers.
 * Instead, we'll fetch individual title XML files directly.
 */

const _USC_BASE_URL =
	"https://uscode.house.gov/download/annualhistoricalarchives";

// Individual title XML URLs (from the release points)
// These are typically in format: usc01.xml, usc02.xml, etc.
const _USC_INDIVIDUAL_BASE =
	"https://uscode.house.gov/download/releasepoints/us/pl";

/**
 * Get list of available USC title XML URLs
 * For simplicity, we'll use a static list of titles (1-54 plus appendices)
 */
export function getUSCTitleUrls(): string[] {
	const titles: string[] = [];

	// Main titles 1-54
	for (let i = 1; i <= 54; i++) {
		const paddedNum = i.toString().padStart(2, "0");
		titles.push(
			`https://uscode.house.gov/download/releasepoints/us/pl/usc${paddedNum}.xml`,
		);
	}

	return titles;
}

/**
 * Fetch a single USC title XML file
 */
export async function fetchUSCTitle(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent": "fastlaw-ingest/1.0",
			},
		});

		if (!response.ok) {
			console.warn(`Failed to fetch ${url}: ${response.status}`);
			return null;
		}

		return await response.text();
	} catch (error) {
		console.error(`Error fetching ${url}:`, error);
		return null;
	}
}

/**
 * Extract title number from USC URL
 */
export function getTitleNumFromUrl(url: string): string | null {
	const match = url.match(/usc(\d+[a-z]?)\.xml$/i);
	if (!match) return null;

	// Remove leading zeros
	const num = match[1].replace(/^0+/, "") || "0";
	return num;
}

/**
 * Fetch all USC titles
 * Returns a map of title number -> XML content
 *
 * Note: This can be slow and may hit CF Worker limits.
 * Consider fetching titles in batches for production use.
 */
export async function fetchAllUSCTitles(
	maxTitles = 54,
	delayMs = 500,
): Promise<Map<string, string>> {
	const results = new Map<string, string>();
	const urls = getUSCTitleUrls().slice(0, maxTitles);

	for (const url of urls) {
		const titleNum = getTitleNumFromUrl(url);
		if (!titleNum) continue;

		console.log(`Fetching USC Title ${titleNum}...`);
		const xml = await fetchUSCTitle(url);

		if (xml) {
			results.set(titleNum, xml);
			console.log(`  -> Got ${xml.length} bytes`);
		}

		// Delay between requests
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return results;
}

/**
 * Alternative: Fetch USC data from a pre-processed R2 bucket
 * This is more reliable for production as it avoids external fetch issues
 */
export async function fetchUSCFromR2(
	storage: R2Bucket,
	prefix = "usc_raw/",
): Promise<Map<string, string>> {
	const results = new Map<string, string>();

	const list = await storage.list({ prefix });

	for (const object of list.objects) {
		const key = object.key;
		const titleNum = key.replace(prefix, "").replace(".xml", "");

		const obj = await storage.get(key);
		if (obj) {
			const xml = await obj.text();
			results.set(titleNum, xml);
		}
	}

	return results;
}
