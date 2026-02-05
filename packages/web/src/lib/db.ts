import type {
	BlobRecord,
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

const NODE_SELECT = `
	id,
	source_version_id,
	readable_id,
	heading_citation,
	parent_id,
	level_name,
	level_index,
	sort_order,
	name,
	path,
	blob_hash,
	source_url,
	accessed_at
`;

function hexToHash64(hex: string): bigint {
	return BigInt(`0x${hex}`);
}

function hash64ToPrefixBytes(hash: bigint): Uint8Array {
	const bytes = new Uint8Array(8);
	for (let i = 0; i < 8; i += 1) {
		const shift = BigInt(56 - i * 8);
		bytes[i] = Number((hash >> shift) & 0xffn);
	}
	return bytes;
}

function prefixMatches(prefix: Uint8Array, expected: Uint8Array): boolean {
	if (prefix.length !== expected.length) return false;
	for (let i = 0; i < prefix.length; i += 1) {
		if (prefix[i] !== expected[i]) return false;
	}
	return true;
}

async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new DecompressionStream("gzip");
	const writer = stream.writable.getWriter();
	const chunk = new Uint8Array(data) as Uint8Array<ArrayBuffer>;
	await writer.write(chunk);
	await writer.close();
	const decompressed = await new Response(stream.readable).arrayBuffer();
	return new Uint8Array(decompressed);
}

async function getBlobLocationByHash(hash: string): Promise<BlobRecord | null> {
	const db = getDB();
	return db
		.prepare(
			"SELECT hash, packfile_key, offset, size FROM blobs WHERE hash = ?",
		)
		.bind(hash)
		.first<BlobRecord>();
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
	sourceId: string,
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
		.prepare("SELECT * FROM sources WHERE id = ?")
		.bind(code)
		.first<SourceRecord>();
}

// Source Versions

export async function getLatestSourceVersion(
	sourceId: string,
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
	versionId: string,
): Promise<SourceVersionRecord | null> {
	const db = getDB();
	return db
		.prepare("SELECT * FROM source_versions WHERE id = ?")
		.bind(versionId)
		.first<SourceVersionRecord>();
}

// Nodes

export async function getNodeById(nodeId: string): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(`SELECT ${NODE_SELECT} FROM nodes WHERE id = ?`)
		.bind(nodeId)
		.first<NodeRecord>();
}

export async function getNodeByPath(
	sourceVersionId: string,
	path: string,
): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE source_version_id = ? AND path = ? LIMIT 1`,
		)
		.bind(sourceVersionId, path)
		.first<NodeRecord>();
}

export async function getNodeByStringId(
	sourceVersionId: string,
	stringId: string,
): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE source_version_id = ? AND id = ? LIMIT 1`,
		)
		.bind(sourceVersionId, stringId)
		.first<NodeRecord>();
}

export async function getRootNode(
	sourceVersionId: string,
): Promise<NodeRecord | null> {
	const db = getDB();
	return db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE source_version_id = ? AND parent_id IS NULL LIMIT 1`,
		)
		.bind(sourceVersionId)
		.first<NodeRecord>();
}

export async function getChildNodes(parentId: string): Promise<NodeRecord[]> {
	const db = getDB();
	const result = await db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE parent_id = ? ORDER BY sort_order`,
		)
		.bind(parentId)
		.all<NodeRecord>();
	return result.results;
}

export async function getTopLevelNodes(
	sourceVersionId: string,
): Promise<NodeRecord[]> {
	const db = getDB();
	const result = await db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE source_version_id = ? AND parent_id IS NULL
       ORDER BY sort_order`,
		)
		.bind(sourceVersionId)
		.all<NodeRecord>();
	return result.results;
}

export async function getSiblingNodes(
	parentId: string,
	sortOrder: number,
): Promise<{ prev: NodeRecord | null; next: NodeRecord | null }> {
	const db = getDB();
	const prev = await db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE parent_id = ? AND sort_order < ?
       ORDER BY sort_order DESC
       LIMIT 1`,
		)
		.bind(parentId, sortOrder)
		.first<NodeRecord>();
	const next = await db
		.prepare(
			`SELECT ${NODE_SELECT} FROM nodes
       WHERE parent_id = ? AND sort_order > ?
       ORDER BY sort_order ASC
       LIMIT 1`,
		)
		.bind(parentId, sortOrder)
		.first<NodeRecord>();
	return { prev: prev ?? null, next: next ?? null };
}

export async function getAncestorNodes(nodeId: string): Promise<NodeRecord[]> {
	const db = getDB();
	const result = await db
		.prepare(
			`WITH RECURSIVE ancestors AS (
        SELECT * FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.* FROM nodes n
        INNER JOIN ancestors a ON n.id = a.parent_id
      )
      SELECT ${NODE_SELECT} FROM ancestors
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
	const storage = getStorage();
	if (node.blob_hash == null) return null;

	const blob = await getBlobLocationByHash(node.blob_hash);
	if (!blob) return null;

	const object = await storage.get(blob.packfile_key, {
		range: {
			offset: blob.offset,
			length: blob.size,
		},
	});
	if (!object) return null;

	const entryData = new Uint8Array(await object.arrayBuffer());
	if (entryData.length < 8) {
		throw new Error(`Blob entry too small in ${blob.packfile_key}`);
	}

	const expected = hash64ToPrefixBytes(hexToHash64(node.blob_hash));
	const prefix = entryData.slice(0, 8);
	if (!prefixMatches(prefix, expected)) {
		throw new Error(`Blob hash prefix mismatch for ${blob.packfile_key}`);
	}

	const content = await decompressGzip(entryData.slice(8));
	const text = new TextDecoder().decode(content);
	return JSON.parse(text) as NodeContent;
}

// Convenience functions for URL-based lookups

export async function findNodeByPath(
	sourceCode: string,
	path: string,
): Promise<{
	node: NodeRecord;
	source: SourceRecord;
	sourceVersion: SourceVersionRecord;
} | null> {
	const source = await getSourceByCode(sourceCode);
	if (!source) return null;

	const sourceVersion = await getLatestSourceVersion(source.id);
	if (!sourceVersion) return null;

	const node = await getNodeByPath(sourceVersion.id, path);
	if (!node) return null;

	return { node, source, sourceVersion };
}

// Legacy compatibility aliases
export const getLevelByPath = async (
	path: string,
): Promise<NodeRecord | null> => {
	// Parse slug to extract source and path
	// Expected format: statutes/{source}/{level_name}/{slug}
	const parts = path.slice(1).split("/");
	if (parts.length < 4) return null;

	const sourceCode = parts[1]; // e.g., "cgs" or "usc"
	const source = await getSourceByCode(sourceCode);
	if (!source) return null;

	const sourceVersion = await getLatestSourceVersion(source.id);
	if (!sourceVersion) return null;

	// Try to find by the full slug or just the last part
	let node = await getNodeByPath(sourceVersion.id, path);
	if (!node) {
		// Try with just the identifying part
		const slugPart = parts.slice(2).join("/");
		node = await getNodeByPath(sourceVersion.id, slugPart);
	}
	return node;
};

export const getLevelsByParentId = async (
	_sourceId: string,
	_docType: string,
	parentId: string,
): Promise<NodeRecord[]> => {
	return getChildNodes(parentId);
};

export const getLevelById = getNodeById;
export const getAncestorLevels = getAncestorNodes;
export const getSiblingLevels = getSiblingNodes;
