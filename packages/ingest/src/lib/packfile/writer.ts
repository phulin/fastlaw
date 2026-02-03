import { hash64, hash64ToHex, hash64ToPrefix } from "./hash";

const MAX_PACKFILE_SIZE = 25 * 1024 * 1024; // 25 MB

export interface BlobEntry {
	hash: bigint; // xxhash64 of content
	content: Uint8Array; // JSON content
}

export interface PackfileResult {
	key: string; // R2 key (e.g., 'cgs/pack-abc123.pack')
	data: Uint8Array; // Uncompressed pack data
	entries: Array<{
		hash: bigint;
		offset: number; // Offset within uncompressed pack
		size: number; // Size of blob (with 8-byte prefix)
	}>;
}

async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream("gzip");
	const writer = stream.writable.getWriter();
	const chunk = new Uint8Array(data) as Uint8Array<ArrayBuffer>;
	await writer.write(chunk);
	await writer.close();
	const compressed = await new Response(stream.readable).arrayBuffer();
	return new Uint8Array(compressed);
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

/**
 * PackfileWriter accumulates blobs and creates packfiles when they reach max size.
 */
export class PackfileWriter {
	private sourceCode: string;
	private currentSize = 0;
	private currentChunks: Uint8Array[] = [];
	private pendingEntries: Array<{
		hash: bigint;
		offset: number;
		size: number;
	}> = [];
	private finishedPackfiles: PackfileResult[] = [];

	constructor(sourceCode: string) {
		this.sourceCode = sourceCode;
	}

	/**
	 * Add a blob to the current packfile.
	 * Returns the hash of the blob.
	 *
	 * If adding this blob would exceed max size, the current packfile is
	 * finalized first and a new one is started.
	 */
	async addBlob(content: Uint8Array): Promise<bigint> {
		const hash = await hash64(content);

		// Create entry: 8-byte hash prefix + gzip-compressed content
		const prefix = hash64ToPrefix(hash);
		const compressed = await compressGzip(content);
		const entryData = new Uint8Array(8 + compressed.length);
		entryData.set(prefix, 0);
		entryData.set(compressed, 8);

		// Check if we need to start a new packfile
		const estimatedNewSize = this.currentSize + entryData.length;
		if (estimatedNewSize > MAX_PACKFILE_SIZE && this.currentSize > 0) {
			// Finalize current packfile before adding
			await this.finalizeCurrentPackfile();
		}

		const offset = this.currentSize;
		this.currentChunks.push(entryData);
		this.currentSize += entryData.length;

		this.pendingEntries.push({
			hash,
			offset,
			size: entryData.length, // Size includes the 8-byte prefix
		});

		return hash;
	}

	/**
	 * Finalize the current packfile and start a new one
	 */
	private async finalizeCurrentPackfile(): Promise<void> {
		if (this.currentSize === 0) {
			return;
		}

		const packData = concatChunks(this.currentChunks, this.currentSize);

		// Hash the pack data for the filename
		const packfileHash = await hash64(packData);
		const key = `${this.sourceCode}/pack-${hash64ToHex(packfileHash)}.pack`;

		this.finishedPackfiles.push({
			key,
			data: packData,
			entries: this.pendingEntries,
		});

		// Reset for next packfile
		this.currentChunks = [];
		this.currentSize = 0;
		this.pendingEntries = [];
	}

	/**
	 * Finalize all pending data and return packfiles to upload
	 */
	async finalize(): Promise<PackfileResult[]> {
		await this.finalizeCurrentPackfile();
		return this.finishedPackfiles;
	}

	/**
	 * Get all finished packfiles so far (for incremental upload)
	 */
	getFinishedPackfiles(): PackfileResult[] {
		return this.finishedPackfiles;
	}

	drainFinishedPackfiles(): PackfileResult[] {
		if (this.finishedPackfiles.length === 0) {
			return [];
		}
		const drained = this.finishedPackfiles;
		this.finishedPackfiles = [];
		return drained;
	}
}

/**
 * Decompress a packfile and extract a blob at the given offset
 */
export async function extractBlob(
	packData: Uint8Array,
	offset: number,
	size: number,
): Promise<{ content: Uint8Array; hashPrefix: Uint8Array }> {
	// Extract entry data (includes 8-byte prefix)
	const entryData = packData.slice(offset, offset + size);

	return {
		hashPrefix: entryData.slice(0, 8),
		content: await decompressGzip(entryData.slice(8)),
	};
}

function concatChunks(chunks: Uint8Array[], totalSize: number): Uint8Array {
	const out = new Uint8Array(totalSize);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
