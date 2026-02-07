import type { Env } from "../../types";

const REQUEST_INTERVAL_MS = 100;

interface RateLimiter {
	waitTurn(): Promise<void>;
}

export function createRateLimiter(intervalMs: number): RateLimiter {
	let nextAllowedAtMs = 0;
	let throttleChain: Promise<void> = Promise.resolve();

	return {
		waitTurn: async () => {
			const scheduled = throttleChain.then(async () => {
				const now = Date.now();
				const waitMs = Math.max(0, nextAllowedAtMs - now);
				if (waitMs > 0) {
					await new Promise<void>((resolve) => {
						setTimeout(resolve, waitMs);
					});
				}
				nextAllowedAtMs = Date.now() + intervalMs;
			});
			throttleChain = scheduled.catch(() => undefined);
			await scheduled;
		},
	};
}

const requestLimiter = createRateLimiter(REQUEST_INTERVAL_MS);

function buildR2Key(versionId: string, url: string): string {
	const parsed = new URL(url);
	const normalizedPath = parsed.pathname
		.toLowerCase()
		.replace(/^\/+/, "")
		.replace(/\/$/, "")
		.replace(/\//g, "_");
	const normalizedQuery = parsed.search
		? `__${encodeURIComponent(parsed.search.slice(1))}`
		: "";
	return `sources/mgl/${versionId}/${normalizedPath}${normalizedQuery}.html`;
}

async function fetchMglText(url: string): Promise<string> {
	await requestLimiter.waitTurn();

	const response = await fetch(url, {
		headers: {
			"User-Agent": "fastlaw-ingest/1.0",
			Accept: "text/html,application/xhtml+xml",
		},
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}
	return await response.text();
}

export async function fetchMglRootHtml(url: string): Promise<string> {
	return await fetchMglText(url);
}

export async function fetchMglHtmlWithCache(
	env: Env,
	versionId: string,
	url: string,
): Promise<string> {
	const key = buildR2Key(versionId, url);
	const cached = await env.STORAGE.get(key);
	if (cached) {
		return await cached.text();
	}

	const html = await fetchMglText(url);
	await env.STORAGE.put(key, html, {
		httpMetadata: { contentType: "text/html" },
	});
	return html;
}

export async function fetchMglTitleChapters(
	env: Env,
	versionId: string,
	baseUrl: string,
	partId: string,
	titleId: string,
	titleCode: string,
): Promise<string> {
	const endpoint = new URL("/GeneralLaws/GetChaptersForTitle", baseUrl);
	endpoint.searchParams.set("partId", partId);
	endpoint.searchParams.set("titleId", titleId);
	endpoint.searchParams.set("code", titleCode);
	return await fetchMglHtmlWithCache(env, versionId, endpoint.toString());
}
