import { extractSectionCrossReferences } from "../src/lib/usc/cross-references";
import {
	streamUSCSectionContentXmlFromChunks,
	streamUSCStructureXmlFromChunks,
	USC_LEVEL_INDEX,
	type USCLevel,
	type USCLevelType,
	type USCParentRef,
} from "../src/lib/usc/parser";
import type { NodePayload } from "../src/types";

export interface UscUnit {
	id: string;
	titleNum: string;
	url: string;
}

export interface IngestConfig {
	units: Array<{ unit: UscUnit; titleSortOrder: number }>;
	callbackBase: string;
	callbackToken: string;
	sourceVersionId: string;
	rootNodeId: string;
}

const BATCH_SIZE = 50;
const R2_CHUNK_SIZE = 5 * 1024 * 1024;
const SECTION_LEVEL_INDEX = Object.keys(USC_LEVEL_INDEX).length;

// ──────────────────────────────────────────────────────────────
// Authenticated fetch helper
// ──────────────────────────────────────────────────────────────

function callbackFetch(
	callbackBase: string,
	callbackToken: string,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return fetch(`${callbackBase}${path}`, {
		...init,
		headers: {
			...(init?.headers as Record<string, string> | undefined),
			Authorization: `Bearer ${callbackToken}`,
		},
	});
}

// ──────────────────────────────────────────────────────────────
// Proxy-based streaming from worker R2 cache
// ──────────────────────────────────────────────────────────────

async function fetchCachedChunks(
	url: string,
	callbackBase: string,
	callbackToken: string,
	extractZip: boolean,
): Promise<AsyncGenerator<Uint8Array, void, void> | null> {
	const cacheRes = await callbackFetch(
		callbackBase,
		callbackToken,
		"/api/proxy/cache",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url, extractZip }),
		},
	);
	if (cacheRes.status === 422) {
		const body = (await cacheRes.json()) as { error: string };
		if (body.error === "html_response") {
			return null;
		}
	}
	if (!cacheRes.ok) {
		throw new Error(
			`Cache proxy failed: ${cacheRes.status} ${await cacheRes.text()}`,
		);
	}
	const { r2Key, totalSize } = (await cacheRes.json()) as {
		r2Key: string;
		totalSize: number;
	};

	return (async function* () {
		let offset = 0;
		while (offset < totalSize) {
			const length = Math.min(R2_CHUNK_SIZE, totalSize - offset);
			const params = new URLSearchParams({
				key: r2Key,
				offset: String(offset),
				length: String(length),
			});
			const chunkRes = await callbackFetch(
				callbackBase,
				callbackToken,
				`/api/proxy/r2-read?${params}`,
			);
			if (!chunkRes.ok) {
				throw new Error(`R2 read failed: ${chunkRes.status}`);
			}
			yield new Uint8Array(await chunkRes.arrayBuffer());
			offset += length;
		}
	})();
}

// ──────────────────────────────────────────────────────────────
// Callback helpers
// ──────────────────────────────────────────────────────────────

async function postNodeBatch(
	callbackBase: string,
	callbackToken: string,
	unitId: string,
	nodes: NodePayload[],
): Promise<void> {
	const res = await callbackFetch(
		callbackBase,
		callbackToken,
		"/api/callback/insertNodeBatch",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ unitId, nodes }),
		},
	);
	if (!res.ok) {
		throw new Error(
			`Insert callback failed: ${res.status} ${await res.text()}`,
		);
	}
}

async function postUnitStart(
	callbackBase: string,
	callbackToken: string,
	unitId: string,
	totalNodes: number,
): Promise<void> {
	const res = await callbackFetch(
		callbackBase,
		callbackToken,
		"/api/callback/unitStart",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ unitId, totalNodes }),
		},
	);
	if (!res.ok) {
		throw new Error(
			`Unit start callback failed: ${res.status} ${await res.text()}`,
		);
	}
}

// ──────────────────────────────────────────────────────────────
// Parent resolution (mirrors adapter.ts logic)
// ──────────────────────────────────────────────────────────────

function resolveLevelParentStringId(
	rootStringId: string,
	level: USCLevel,
	levelTypeByIdentifier: Map<string, USCLevelType>,
): string {
	if (level.parentIdentifier?.endsWith("-title")) {
		return `${rootStringId}/title-${level.titleNum}`;
	}
	if (level.parentIdentifier) {
		const parentType = levelTypeByIdentifier.get(level.parentIdentifier);
		if (parentType) {
			return `${rootStringId}/${parentType}-${level.parentIdentifier}`;
		}
	}
	return `${rootStringId}/title-${level.titleNum}`;
}

function resolveSectionParentStringId(
	rootStringId: string,
	parentRef: USCParentRef,
): string {
	if (parentRef.kind === "title") {
		return `${rootStringId}/title-${parentRef.titleNum}`;
	}
	return `${rootStringId}/${parentRef.levelType}-${parentRef.identifier}`;
}

// ──────────────────────────────────────────────────────────────
// Per-unit ingest
// ──────────────────────────────────────────────────────────────

type UnitStatus = "completed" | "skipped";

async function ingestUSCUnit(
	unit: UscUnit,
	titleSortOrder: number,
	callbackBase: string,
	callbackToken: string,
	sourceVersionId: string,
	rootNodeId: string,
): Promise<UnitStatus> {
	const accessedAt = new Date().toISOString();
	const rootStringId = rootNodeId;

	console.log(`[Container] Starting ingest for Title ${unit.titleNum}`);

	// ── Phase 1: Parse structure ─────────────────────────────
	const structureChunks = await fetchCachedChunks(
		unit.url,
		callbackBase,
		callbackToken,
		true,
	);
	if (!structureChunks) {
		console.log(`[Container] Title ${unit.titleNum}: skipped (HTML response)`);
		return "skipped";
	}
	const structureStream = streamUSCStructureXmlFromChunks(
		structureChunks,
		unit.titleNum,
		unit.url,
	);

	const pendingNodes: NodePayload[] = [];
	const seenLevelIds = new Set<string>();
	const levelTypeByIdentifier = new Map<string, USCLevelType>();
	const sectionRefs: Array<{
		sectionKey: string;
		parentId: string;
		childId: string;
	}> = [];
	let levelSortOrder = 0;
	let titleEmitted = false;

	const ensureTitleNode = (titleNum: string, titleName: string) => {
		if (titleEmitted) return;
		titleEmitted = true;

		const titleStringId = `${rootStringId}/title-${titleNum}`;
		seenLevelIds.add(`title-${titleNum}`);

		pendingNodes.push({
			meta: {
				id: titleStringId,
				source_version_id: sourceVersionId,
				parent_id: rootStringId,
				level_name: "title",
				level_index: 0,
				sort_order: titleSortOrder,
				name: titleName,
				path: `/statutes/usc/title/${titleNum}`,
				readable_id: titleNum,
				heading_citation: `Title ${titleNum}`,
				source_url: unit.url,
				accessed_at: accessedAt,
			},
			content: null,
		});
	};

	for await (const event of structureStream) {
		if (event.type === "title") {
			ensureTitleNode(event.titleNum, event.titleName);
			continue;
		}

		if (event.type === "level") {
			const level = event.level;
			if (seenLevelIds.has(level.identifier)) continue;
			ensureTitleNode(level.titleNum, `Title ${level.titleNum}`);

			const parentStringId = resolveLevelParentStringId(
				rootStringId,
				level,
				levelTypeByIdentifier,
			);
			const stringId = `${rootStringId}/${level.levelType}-${level.identifier}`;
			const headingCitation = `${level.levelType.charAt(0).toUpperCase() + level.levelType.slice(1)} ${level.num}`;

			pendingNodes.push({
				meta: {
					id: stringId,
					source_version_id: sourceVersionId,
					parent_id: parentStringId,
					level_name: level.levelType,
					level_index: level.levelIndex,
					sort_order: levelSortOrder++,
					name: level.heading,
					path: `/statutes/usc/${level.levelType}/${level.titleNum}/${level.num}`,
					readable_id: level.num,
					heading_citation: headingCitation,
					source_url: null,
					accessed_at: accessedAt,
				},
				content: null,
			});

			levelTypeByIdentifier.set(level.identifier, level.levelType);
			seenLevelIds.add(level.identifier);
			continue;
		}

		// section ref
		const section = event.section;
		const parentStringId = resolveSectionParentStringId(
			rootStringId,
			section.parentRef,
		);
		const childId = `${parentStringId}/section-${section.sectionNum}`;

		sectionRefs.push({
			sectionKey: section.sectionKey,
			parentId: parentStringId,
			childId,
		});
	}

	ensureTitleNode(unit.titleNum, `Title ${unit.titleNum}`);

	const totalNodes = pendingNodes.length + sectionRefs.length;
	await postUnitStart(callbackBase, callbackToken, unit.id, totalNodes);

	// Flush structure nodes in batches
	for (let i = 0; i < pendingNodes.length; i += BATCH_SIZE) {
		await postNodeBatch(
			callbackBase,
			callbackToken,
			unit.id,
			pendingNodes.slice(i, i + BATCH_SIZE),
		);
	}

	console.log(
		`[Container] Title ${unit.titleNum}: ${pendingNodes.length} structure nodes, ${sectionRefs.length} sections`,
	);

	// ── Phase 2: Parse section content ───────────────────────
	if (sectionRefs.length > 0) {
		const contentChunks = await fetchCachedChunks(
			unit.url,
			callbackBase,
			callbackToken,
			true,
		);
		// Content was already cached in phase 1, so null here is unexpected
		if (!contentChunks) {
			throw new Error(
				`Title ${unit.titleNum}: unexpected HTML response on second fetch`,
			);
		}
		const contentStream = streamUSCSectionContentXmlFromChunks(
			contentChunks,
			unit.titleNum,
			unit.url,
		);

		const sectionByKey = new Map(
			sectionRefs.map((s) => [s.sectionKey, s] as const),
		);
		const sectionBatch: NodePayload[] = [];

		for await (const section of contentStream) {
			const item = sectionByKey.get(section.sectionKey);
			if (!item) continue;

			const crossReferences = extractSectionCrossReferences(
				[section.body, section.citations].filter(Boolean).join("\n"),
				section.titleNum,
			);

			const content: {
				blocks: Array<{ type: string; content: string; label?: string }>;
				metadata?: { cross_references: typeof crossReferences };
			} = {
				blocks: [
					{ type: "body", content: section.body },
					...(section.historyShort
						? [
								{
									type: "history_short" as const,
									label: "Short History",
									content: section.historyShort,
								},
							]
						: []),
					...(section.historyLong
						? [
								{
									type: "history_long" as const,
									label: "Long History",
									content: section.historyLong,
								},
							]
						: []),
					...(section.citations
						? [
								{
									type: "citations" as const,
									label: "Notes",
									content: section.citations,
								},
							]
						: []),
				],
			};

			if (crossReferences.length > 0) {
				content.metadata = { cross_references: crossReferences };
			}

			const readableId = `${section.titleNum} USC ${section.sectionNum}`;

			sectionBatch.push({
				meta: {
					id: item.childId,
					source_version_id: sourceVersionId,
					parent_id: item.parentId,
					level_name: "section",
					level_index: SECTION_LEVEL_INDEX,
					sort_order: 0,
					name: section.heading,
					path: section.path,
					readable_id: readableId,
					heading_citation: readableId,
					source_url: null,
					accessed_at: accessedAt,
				},
				content,
			});

			if (sectionBatch.length >= BATCH_SIZE) {
				await postNodeBatch(callbackBase, callbackToken, unit.id, sectionBatch);
				sectionBatch.length = 0;
			}

			sectionByKey.delete(section.sectionKey);
		}

		if (sectionBatch.length > 0) {
			await postNodeBatch(callbackBase, callbackToken, unit.id, sectionBatch);
		}

		if (sectionByKey.size > 0) {
			const missing = [...sectionByKey.keys()].slice(0, 5);
			console.warn(
				`[Container] Title ${unit.titleNum}: ${sectionByKey.size} sections not found in content pass: ${missing.join(", ")}`,
			);
		}
	}

	console.log(`[Container] Title ${unit.titleNum}: done`);
	return "completed";
}

// ──────────────────────────────────────────────────────────────
// Main entry point — loops over all units
// ──────────────────────────────────────────────────────────────

export async function ingestUSC(config: IngestConfig): Promise<void> {
	const { units, callbackBase, callbackToken, sourceVersionId, rootNodeId } =
		config;

	console.log(`[Container] Starting ingest for ${units.length} units`);

	for (const { unit, titleSortOrder } of units) {
		try {
			const status = await ingestUSCUnit(
				unit,
				titleSortOrder,
				callbackBase,
				callbackToken,
				sourceVersionId,
				rootNodeId,
			);
			await callbackFetch(
				callbackBase,
				callbackToken,
				"/api/callback/progress",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ unitId: unit.id, status }),
				},
			);
		} catch (err) {
			console.error(`[Container] Title ${unit.titleNum} failed:`, err);
			await callbackFetch(
				callbackBase,
				callbackToken,
				"/api/callback/progress",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						unitId: unit.id,
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					}),
				},
			).catch(() => {});
		}
	}

	console.log("[Container] All units complete");
}
