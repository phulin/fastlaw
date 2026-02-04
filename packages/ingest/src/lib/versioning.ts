import type { DiffResult, NodeInsert, SourceVersion } from "../types";

export type { NodeInsert };

/**
 * Get or create a source by its code
 */
export async function getOrCreateSource(
	db: D1Database,
	code: string,
	name: string,
	jurisdiction: string,
	region: string,
	docType: string,
): Promise<number> {
	// Try to get existing source
	const existing = await db
		.prepare("SELECT id FROM sources WHERE code = ?")
		.bind(code)
		.first<{ id: number }>();

	if (existing) {
		return existing.id;
	}

	// Create new source
	const result = await db
		.prepare(`
			INSERT INTO sources (code, name, jurisdiction, region, doc_type)
			VALUES (?, ?, ?, ?, ?)
		`)
		.bind(code, name, jurisdiction, region, docType)
		.run();

	return result.meta.last_row_id as number;
}

/**
 * Get or create a source version for a given date
 */
export async function getOrCreateSourceVersion(
	db: D1Database,
	sourceId: number,
	versionDate: string,
): Promise<number> {
	const canonicalName = `${await getSourceCode(db, sourceId)}-${versionDate}`;

	// Check if version already exists
	const existing = await db
		.prepare(
			"SELECT id FROM source_versions WHERE source_id = ? AND canonical_name = ?",
		)
		.bind(sourceId, canonicalName)
		.first<{ id: number }>();

	if (existing) {
		return existing.id;
	}

	// Create new version
	const result = await db
		.prepare(`
			INSERT INTO source_versions (source_id, canonical_name, version_date)
			VALUES (?, ?, ?)
		`)
		.bind(sourceId, canonicalName, versionDate)
		.run();

	return result.meta.last_row_id as number;
}

/**
 * Get the source code by ID
 */
async function getSourceCode(
	db: D1Database,
	sourceId: number,
): Promise<string> {
	const result = await db
		.prepare("SELECT code FROM sources WHERE id = ?")
		.bind(sourceId)
		.first<{ code: string }>();

	return result?.code ?? "unknown";
}

/**
 * Get the latest version for a source
 */
export async function getLatestVersion(
	db: D1Database,
	sourceId: number,
): Promise<SourceVersion | null> {
	const result = await db
		.prepare(`
			SELECT * FROM source_versions
			WHERE source_id = ?
			ORDER BY version_date DESC
			LIMIT 1
		`)
		.bind(sourceId)
		.first<SourceVersion>();

	return result ?? null;
}

/**
 * Update the root_node_id for a source version
 */
export async function setRootNodeId(
	db: D1Database,
	versionId: number,
	rootNodeId: number,
): Promise<void> {
	await db
		.prepare("UPDATE source_versions SET root_node_id = ? WHERE id = ?")
		.bind(rootNodeId, versionId)
		.run();
}

/**
 * Compute diff between two versions using string_id
 */
export async function computeDiff(
	db: D1Database,
	oldVersionId: number,
	newVersionId: number,
): Promise<DiffResult> {
	if (oldVersionId === newVersionId) {
		return { added: [], removed: [], modified: [] };
	}

	// Get all string_ids from old version
	const oldNodes = await db
		.prepare("SELECT string_id FROM nodes WHERE source_version_id = ?")
		.bind(oldVersionId)
		.all<{ string_id: string }>();

	// Get all string_ids from new version
	const newNodes = await db
		.prepare("SELECT string_id FROM nodes WHERE source_version_id = ?")
		.bind(newVersionId)
		.all<{ string_id: string }>();

	const oldSet = new Set(oldNodes.results.map((n) => n.string_id));
	const newSet = new Set(newNodes.results.map((n) => n.string_id));

	// Find added (in new but not in old)
	const added = [...newSet].filter((id) => !oldSet.has(id));

	// Find removed (in old but not in new)
	const removed = [...oldSet].filter((id) => !newSet.has(id));

	// For modified, we need to compare content
	// This is more complex - for now, just check nodes that exist in both
	const modifiedRows = await db
		.prepare(
			`
			SELECT new_nodes.string_id
			FROM nodes new_nodes
			JOIN nodes old_nodes
				ON old_nodes.source_version_id = ?
				AND old_nodes.string_id = new_nodes.string_id
			WHERE new_nodes.source_version_id = ?
				AND old_nodes.blob_hash IS NOT new_nodes.blob_hash
		`,
		)
		.bind(oldVersionId, newVersionId)
		.all<{ string_id: string }>();

	const modified = modifiedRows.results.map((row) => row.string_id);

	return { added, removed, modified };
}

/**
 * Insert a node into the database
 */
export async function insertNode(
	db: D1Database,
	versionId: number,
	stringId: string,
	parentId: number | null,
	levelName: string,
	levelIndex: number,
	sortOrder: number,
	name: string | null,
	path: string | null,
	readableId: string | null,
	headingCitation: string | null,
	blobHash: string | null,
	sourceUrl: string | null,
	accessedAt: string | null,
): Promise<number> {
	const result = await db
		.prepare(`
			INSERT INTO nodes (
				source_version_id, string_id, parent_id, level_name, level_index,
				sort_order, name, path, readable_id, heading_citation, blob_hash,
				source_url, accessed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.bind(
			versionId,
			stringId,
			parentId,
			levelName,
			levelIndex,
			sortOrder,
			name,
			path,
			readableId,
			headingCitation,
			blobHash,
			sourceUrl,
			accessedAt,
		)
		.run();

	return result.meta.last_row_id as number;
}

/**
 * Get a node ID by its string_id within a version
 */
export async function getNodeIdByStringId(
	db: D1Database,
	versionId: number,
	stringId: string,
): Promise<number | null> {
	const result = await db
		.prepare(
			"SELECT id FROM nodes WHERE source_version_id = ? AND string_id = ?",
		)
		.bind(versionId, stringId)
		.first<{ id: number }>();

	return result?.id ?? null;
}

const BATCH_SIZE = 50;

/**
 * Insert multiple nodes in batches for better performance.
 * Returns a map from stringId to nodeId.
 */
export async function insertNodesBatched(
	db: D1Database,
	nodes: NodeInsert[],
): Promise<Map<string, number>> {
	const nodeIdMap = new Map<string, number>();

	for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
		const batch = nodes.slice(i, i + BATCH_SIZE);
		const statements = batch.map((node) =>
			db
				.prepare(
					`INSERT INTO nodes (
						source_version_id, string_id, parent_id, level_name, level_index,
						sort_order, name, path, readable_id, heading_citation, blob_hash,
						source_url, accessed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					node.source_version_id,
					node.string_id,
					node.parent_id,
					node.level_name,
					node.level_index,
					node.sort_order,
					node.name,
					node.path,
					node.readable_id,
					node.heading_citation,
					node.blob_hash,
					node.source_url,
					node.accessed_at,
				),
		);

		const results = await db.batch(statements);

		for (let j = 0; j < batch.length; j++) {
			const nodeId = results[j].meta.last_row_id as number;
			nodeIdMap.set(batch[j].string_id, nodeId);
		}

		if ((i + batch.length) % 1000 === 0 || i + batch.length === nodes.length) {
			console.log(`Inserted ${i + batch.length}/${nodes.length} nodes...`);
		}
	}

	return nodeIdMap;
}
