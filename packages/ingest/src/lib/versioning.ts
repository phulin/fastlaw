import type { DiffResult, NodeInsert, SourceVersion } from "../types";

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
): Promise<string> {
	// Try to get existing source
	const existing = await db
		.prepare("SELECT id FROM sources WHERE id = ?")
		.bind(code)
		.first<{ id: string }>();

	if (existing) {
		return existing.id;
	}

	// Create new source
	const _result = await db
		.prepare(`
			INSERT INTO sources (id, name, jurisdiction, region, doc_type)
			VALUES (?, ?, ?, ?, ?)
		`)
		.bind(code, name, jurisdiction, region, docType)
		.run();

	return code;
}

/**
 * Get or create a source version for a given date
 */
export async function ensureSourceVersion(
	db: D1Database,
	sourceId: string,
	versionDate: string,
): Promise<void> {
	const canonicalName = `${sourceId}-${versionDate}`;

	// Create new version
	await db
		.prepare(`
			INSERT OR IGNORE INTO source_versions (id, source_id, version_date)
			VALUES (?, ?, ?)
		`)
		.bind(canonicalName, sourceId, versionDate)
		.run();
}

/**
 * Get the latest version for a source
 */
export async function getLatestVersion(
	db: D1Database,
	sourceId: string,
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
	versionId: string,
	rootNodeId: string,
): Promise<void> {
	await db
		.prepare("UPDATE source_versions SET root_node_id = ? WHERE id = ?")
		.bind(rootNodeId, versionId)
		.run();
}

/**
 * Compute diff between two versions using node IDs
 */
export async function computeDiff(
	db: D1Database,
	oldVersionId: string,
	newVersionId: string,
): Promise<DiffResult> {
	if (oldVersionId === newVersionId) {
		return { added: [], removed: [], modified: [] };
	}

	// Get all node IDs from old version
	const oldNodes = await db
		.prepare("SELECT id FROM nodes WHERE source_version_id = ?")
		.bind(oldVersionId)
		.all<{ id: string }>();

	// Get all node IDs from new version
	const newNodes = await db
		.prepare("SELECT id FROM nodes WHERE source_version_id = ?")
		.bind(newVersionId)
		.all<{ id: string }>();

	const oldSet = new Set(oldNodes.results.map((n) => n.id));
	const newSet = new Set(newNodes.results.map((n) => n.id));

	// Find added (in new but not in old)
	const added = [...newSet].filter((id) => !oldSet.has(id));

	// Find removed (in old but not in new)
	const removed = [...oldSet].filter((id) => !newSet.has(id));

	// For modified, we need to compare content
	// This is more complex - for now, just check nodes that exist in both
	const modifiedRows = await db
		.prepare(
			`
			SELECT new_nodes.id
			FROM nodes new_nodes
			JOIN nodes old_nodes
				ON old_nodes.source_version_id = ?
				AND old_nodes.id = new_nodes.id
			WHERE new_nodes.source_version_id = ?
				AND old_nodes.blob_hash IS NOT new_nodes.blob_hash
		`,
		)
		.bind(oldVersionId, newVersionId)
		.all<{ id: string }>();

	const modified = modifiedRows.results.map((row) => row.id);

	return { added, removed, modified };
}

/**
 * Insert a node into the database
 */
export async function insertNode(
	db: D1Database,
	versionId: string,
	stringId: string,
	parentId: string | null,
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
): Promise<string> {
	await db
		.prepare(`
			INSERT OR IGNORE INTO nodes (
				id, source_version_id, parent_id, level_name, level_index,
				sort_order, name, path, readable_id, heading_citation, blob_hash,
				source_url, accessed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.bind(
			stringId,
			versionId,
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
	return stringId;
}

/**
 * Get a node ID by its string ID within a version
 */
export async function getNodeIdByStringId(
	db: D1Database,
	versionId: string,
	stringId: string,
): Promise<string | null> {
	const result = await db
		.prepare("SELECT id FROM nodes WHERE source_version_id = ? AND id = ?")
		.bind(versionId, stringId)
		.first<{ id: string }>();

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
): Promise<Map<string, string>> {
	const nodeIdMap = new Map<string, string>();

	for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
		const batch = nodes.slice(i, i + BATCH_SIZE);
		const statements = batch.map((node) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO nodes (
						id, source_version_id, parent_id, level_name, level_index,
						sort_order, name, path, readable_id, heading_citation, blob_hash,
						source_url, accessed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					node.id,
					node.source_version_id,
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

		await db.batch(statements);

		for (const node of batch) {
			nodeIdMap.set(node.id, node.id);
		}

		if ((i + batch.length) % 1000 === 0 || i + batch.length === nodes.length) {
			console.log(`Inserted ${i + batch.length}/${nodes.length} nodes...`);
		}
	}

	return nodeIdMap;
}
