import type {
	Env,
	NodeContent,
	NodeRecord,
	SourceRecord,
	SourceVersionRecord,
} from "./types";

let envRef: Env | null = null;

export const setEnv = (env: Env) => {
	envRef = env;
};

function getEnv(): Env {
	if (!envRef) {
		throw new Error("Cloudflare environment not available");
	}
	return envRef;
}

function getDB(): D1Database {
	return getEnv().DB;
}

function getStorage(): R2Bucket {
	return getEnv().STORAGE;
}

// Sources

export async function getSources(): Promise<SourceRecord[]> {
	const db = getDB();
	const result = await db
		.prepare("SELECT * FROM sources ORDER BY name")
		.all<SourceRecord>();
	return result.results;
}

export async function getSourceById(
	sourceId: number,
): Promise<SourceRecord | null> {
	const db = getDB();
	return db
		.prepare("SELECT * FROM sources WHERE id = ?")
		.bind(sourceId)
		.first<SourceRecord>();
}

export async function getSourceByCode(
	code: string,
): Promise<SourceRecord | null> {
	const db = getDB();
	return db
		.prepare("SELECT * FROM sources WHERE code = ?")
		.bind(code)
		.first<SourceRecord>();
}

// Source Versions

export async function getLatestSourceVersion(
	sourceId: number,
): Promise<SourceVersionRecord | null> {
	const db = getDB();
	return db
		.prepare(
			`SELECT * FROM source_versions
       WHERE source_id = ?
       ORDER BY version_date DESC
       LIMIT 1`,
		)
		.bind(sourceId)
		.first<SourceVersionRecord>();
}

export async function getSourceVersionById(
	versionId: number,
): Promise<SourceVersionRecord | null> {
	const db = getDB();
	return db
		.prepare("SELECT * FROM source_versions WHERE id = ?")
		.bind(versionId)
		.first<SourceVersionRecord>();
}

// Nodes

export async function getNodeById(nodeId: number): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare("SELECT * FROM nodes WHERE id = ?")
		.bind(nodeId)
		.first<NodeRecord>();
}

export async function getNodeBySlug(
	sourceVersionId: number,
	slug: string,
): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(
			"SELECT * FROM nodes WHERE source_version_id = ? AND slug = ? LIMIT 1",
		)
		.bind(sourceVersionId, slug)
		.first<NodeRecord>();
}

export async function getNodeByStringId(
	sourceVersionId: number,
	stringId: string,
): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(
			"SELECT * FROM nodes WHERE source_version_id = ? AND string_id = ? LIMIT 1",
		)
		.bind(sourceVersionId, stringId)
		.first<NodeRecord>();
}

export async function getRootNode(
	sourceVersionId: number,
): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(
			"SELECT * FROM nodes WHERE source_version_id = ? AND parent_id IS NULL LIMIT 1",
		)
		.bind(sourceVersionId)
		.first<NodeRecord>();
}

export async function getChildNodes(parentId: number): Promise<NodeRecord[]> {
	const db = getDB();
	const result = await db
		.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY sort_order")
		.bind(parentId)
		.all<NodeRecord>();
	return result.results;
}

export async function getTopLevelNodes(
	sourceVersionId: number,
): Promise<NodeRecord[]> {
	const db = getDB();
	const result = await db
		.prepare(
			`SELECT * FROM nodes
       WHERE source_version_id = ? AND parent_id IS NULL
       ORDER BY sort_order`,
		)
		.bind(sourceVersionId)
		.all<NodeRecord>();
	return result.results;
}

export async function getSiblingNodes(
	parentId: number,
	sortOrder: number,
): Promise<{ prev: NodeRecord | null; next: NodeRecord | null }> {
	const db = getDB();
	const prev = await db
		.prepare(
			`SELECT * FROM nodes
       WHERE parent_id = ? AND sort_order < ?
       ORDER BY sort_order DESC
       LIMIT 1`,
		)
		.bind(parentId, sortOrder)
		.first<NodeRecord>();
	const next = await db
		.prepare(
			`SELECT * FROM nodes
       WHERE parent_id = ? AND sort_order > ?
       ORDER BY sort_order ASC
       LIMIT 1`,
		)
		.bind(parentId, sortOrder)
		.first<NodeRecord>();
	return { prev: prev ?? null, next: next ?? null };
}

export async function getAncestorNodes(nodeId: number): Promise<NodeRecord[]> {
	const db = getDB();
	const result = await db
		.prepare(
			`WITH RECURSIVE ancestors AS (
        SELECT * FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.* FROM nodes n
        INNER JOIN ancestors a ON n.id = a.parent_id
      )
      SELECT * FROM ancestors
      ORDER BY level_index ASC`,
		)
		.bind(nodeId)
		.all<NodeRecord>();
	return result.results;
}

// R2 Content

export async function getNodeContent(
	node: NodeRecord,
): Promise<NodeContent | null> {
	if (!node.blob_key) return null;

	const storage = getStorage();

	// Use range read if offset and size are specified
	if (node.blob_offset != null && node.blob_size != null) {
		const object = await storage.get(node.blob_key, {
			range: {
				offset: node.blob_offset,
				length: node.blob_size,
			},
		});
		if (!object) return null;
		const text = await object.text();
		return JSON.parse(text) as NodeContent;
	}

	// Otherwise read the whole blob
	const object = await storage.get(node.blob_key);
	if (!object) return null;
	return object.json<NodeContent>();
}

export async function getContentByBlobKey(
	blobKey: string,
): Promise<NodeContent | null> {
	const storage = getStorage();
	const object = await storage.get(blobKey);
	if (!object) return null;
	return object.json<NodeContent>();
}

// Convenience functions for URL-based lookups

export async function findNodeByPath(
	sourceCode: string,
	slugPath: string,
): Promise<{
	node: NodeRecord;
	source: SourceRecord;
	sourceVersion: SourceVersionRecord;
} | null> {
	const source = await getSourceByCode(sourceCode);
	if (!source) return null;

	const sourceVersion = await getLatestSourceVersion(source.id);
	if (!sourceVersion) return null;

	const node = await getNodeBySlug(sourceVersion.id, slugPath);
	if (!node) return null;

	return { node, source, sourceVersion };
}

// Legacy compatibility aliases
export const getLevelBySlug = async (
	slug: string,
): Promise<NodeRecord | null> => {
	// Parse slug to extract source and path
	// Expected format: statutes/{source}/{level_name}/{slug_part}
	const parts = slug.split("/");
	if (parts.length < 4) return null;

	const sourceCode = parts[1]; // e.g., "cgs" or "usc"
	const source = await getSourceByCode(sourceCode);
	if (!source) return null;

	const sourceVersion = await getLatestSourceVersion(source.id);
	if (!sourceVersion) return null;

	// Try to find by the full slug or just the last part
	let node = await getNodeBySlug(sourceVersion.id, slug);
	if (!node) {
		// Try with just the identifying part
		const slugPart = parts.slice(2).join("/");
		node = await getNodeBySlug(sourceVersion.id, slugPart);
	}
	return node;
};

export const getLevelsByParentId = async (
	_sourceId: number,
	_docType: string,
	parentId: number,
): Promise<NodeRecord[]> => {
	return getChildNodes(parentId);
};

export const getLevelById = getNodeById;
export const getAncestorLevels = getAncestorNodes;
export const getSiblingLevels = getSiblingNodes;
