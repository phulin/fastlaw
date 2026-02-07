import type { Env } from "../../types";
import type {
	MglApiChapter,
	MglApiPart,
	MglApiPartSummary,
	MglApiSection,
} from "./parser";

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
	return `sources/mgl/${versionId}/${normalizedPath}${normalizedQuery}.json`;
}

async function fetchMglText(url: string, accept: string): Promise<string> {
	await requestLimiter.waitTurn();

	const response = await fetch(url, {
		headers: {
			"User-Agent": "fastlaw-ingest/1.0",
			Accept: accept,
		},
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}
	return await response.text();
}

export async function fetchMglLandingHtml(url: string): Promise<string> {
	return await fetchMglText(url, "text/html,application/xhtml+xml");
}

async function fetchJsonWithCache<T>(
	env: Env,
	versionId: string,
	url: string,
): Promise<T> {
	const key = buildR2Key(versionId, url);
	const cached = await env.STORAGE.get(key);
	if (cached) {
		return (await cached.json()) as T;
	}

	const body = await fetchMglText(url, "application/json");
	await env.STORAGE.put(key, body, {
		httpMetadata: { contentType: "application/json" },
	});
	return JSON.parse(body) as T;
}

export function createMglApiUrl(baseUrl: string, path: string): string {
	return new URL(path, `${baseUrl}/`).toString();
}

export async function fetchMglParts(
	env: Env,
	versionId: string,
	baseUrl: string,
): Promise<MglApiPartSummary[]> {
	return await fetchJsonWithCache<MglApiPartSummary[]>(
		env,
		versionId,
		createMglApiUrl(baseUrl, "/api/Parts"),
	);
}

export async function fetchMglPart(
	env: Env,
	versionId: string,
	baseUrl: string,
	partCode: string,
): Promise<MglApiPart> {
	return await fetchJsonWithCache<MglApiPart>(
		env,
		versionId,
		createMglApiUrl(baseUrl, `/api/Parts/${encodeURIComponent(partCode)}`),
	);
}

export async function fetchMglChapter(
	env: Env,
	versionId: string,
	baseUrl: string,
	chapterCode: string,
): Promise<MglApiChapter> {
	return await fetchJsonWithCache<MglApiChapter>(
		env,
		versionId,
		createMglApiUrl(
			baseUrl,
			`/api/Chapters/${encodeURIComponent(chapterCode)}`,
		),
	);
}

export async function fetchMglSection(
	env: Env,
	versionId: string,
	baseUrl: string,
	chapterCode: string,
	sectionCode: string,
): Promise<MglApiSection> {
	return await fetchJsonWithCache<MglApiSection>(
		env,
		versionId,
		createMglApiUrl(
			baseUrl,
			`/api/Chapters/${encodeURIComponent(chapterCode)}/Sections/${encodeURIComponent(sectionCode)}`,
		),
	);
}
