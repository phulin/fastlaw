import type { DiffResult, SourceVersion } from "../types";

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
	sectionNameTemplate: string | null = null,
): Promise<number> {
	// Try to get existing source
	const existing = await db
		.prepare("SELECT id FROM sources WHERE code = ?")
		.bind(code)
		.first<{ id: number }>();

	if (existing) {
		// Update section_name_template if provided and different
		if (sectionNameTemplate !== null) {
			await db
				.prepare("UPDATE sources SET section_name_template = ? WHERE id = ?")
				.bind(sectionNameTemplate, existing.id)
				.run();
		}
		return existing.id;
	}

	// Create new source
	const result = await db
		.prepare(`
			INSERT INTO sources (code, name, jurisdiction, region, doc_type, section_name_template)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
		.bind(code, name, jurisdiction, region, docType, sectionNameTemplate)
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
	const common = [...newSet].filter((id) => oldSet.has(id));

	// Compare blob references or content for modified detection
	const modified: string[] = [];
	for (const stringId of common) {
		const oldNode = await db
			.prepare(
				"SELECT blob_key, blob_offset, blob_size FROM nodes WHERE source_version_id = ? AND string_id = ?",
			)
			.bind(oldVersionId, stringId)
			.first<{
				blob_key: string | null;
				blob_offset: number | null;
				blob_size: number | null;
			}>();

		const newNode = await db
			.prepare(
				"SELECT blob_key, blob_offset, blob_size FROM nodes WHERE source_version_id = ? AND string_id = ?",
			)
			.bind(newVersionId, stringId)
			.first<{
				blob_key: string | null;
				blob_offset: number | null;
				blob_size: number | null;
			}>();

		// If blob references differ, mark as modified
		if (
			oldNode?.blob_key !== newNode?.blob_key ||
			oldNode?.blob_offset !== newNode?.blob_offset ||
			oldNode?.blob_size !== newNode?.blob_size
		) {
			modified.push(stringId);
		}
	}

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
	blobKey: string | null,
	blobOffset: number | null,
	blobSize: number | null,
	sourceUrl: string | null,
	accessedAt: string | null,
): Promise<number> {
	const result = await db
		.prepare(`
			INSERT INTO nodes (
				source_version_id, string_id, parent_id, level_name, level_index,
				sort_order, name, path, readable_id, blob_key, blob_offset, blob_size,
				source_url, accessed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			blobKey,
			blobOffset,
			blobSize,
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
