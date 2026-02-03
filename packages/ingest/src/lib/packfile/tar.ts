/**
 * Minimal tar file format implementation for packfiles.
 * We only need to write and read sequential entries.
 *
 * Tar format:
 * - 512-byte header block
 * - File content (padded to 512 bytes)
 * - Two 512-byte zero blocks at end
 */

const BLOCK_SIZE = 512;

/**
 * Create a tar header for a file entry
 */
function createTarHeader(
	filename: string,
	fileSize: number,
	mtime: number = Math.floor(Date.now() / 1000),
): Uint8Array {
	const header = new Uint8Array(BLOCK_SIZE);
	const encoder = new TextEncoder();

	// File name (100 bytes) - use hash as filename
	const nameBytes = encoder.encode(filename.slice(0, 99));
	header.set(nameBytes, 0);

	// File mode (8 bytes, octal) - 644
	header.set(encoder.encode("0000644\0"), 100);

	// UID (8 bytes, octal) - 0
	header.set(encoder.encode("0000000\0"), 108);

	// GID (8 bytes, octal) - 0
	header.set(encoder.encode("0000000\0"), 116);

	// File size (12 bytes, octal)
	const sizeOctal = fileSize.toString(8).padStart(11, "0");
	header.set(encoder.encode(`${sizeOctal}\0`), 124);

	// Modification time (12 bytes, octal)
	const mtimeOctal = mtime.toString(8).padStart(11, "0");
	header.set(encoder.encode(`${mtimeOctal}\0`), 136);

	// Checksum placeholder (8 bytes) - fill with spaces for calculation
	header.fill(32, 148, 156); // ASCII space

	// Type flag (1 byte) - '0' for regular file
	header[156] = 48; // ASCII '0'

	// Link name (100 bytes) - empty
	// Already zeroed

	// USTAR magic (6 bytes)
	header.set(encoder.encode("ustar\0"), 257);

	// USTAR version (2 bytes)
	header.set(encoder.encode("00"), 263);

	// Owner name (32 bytes)
	header.set(encoder.encode("root"), 265);

	// Group name (32 bytes)
	header.set(encoder.encode("root"), 297);

	// Calculate and set checksum
	let checksum = 0;
	for (let i = 0; i < BLOCK_SIZE; i++) {
		checksum += header[i];
	}
	const checksumOctal = checksum.toString(8).padStart(6, "0");
	header.set(encoder.encode(`${checksumOctal}\0 `), 148);

	return header;
}

/**
 * Pad data to tar block size (512 bytes)
 */
function padToBlock(data: Uint8Array): Uint8Array {
	const remainder = data.length % BLOCK_SIZE;
	if (remainder === 0) {
		return data;
	}
	const paddedLength = data.length + (BLOCK_SIZE - remainder);
	const padded = new Uint8Array(paddedLength);
	padded.set(data);
	return padded;
}

export interface TarEntry {
	filename: string;
	data: Uint8Array;
	offset: number; // Offset of data within the tar (after header)
}

/**
 * TarWriter accumulates entries and produces a tar archive
 */
export class TarWriter {
	private entries: { filename: string; data: Uint8Array }[] = [];
	private totalSize = 0;

	/**
	 * Add an entry to the tar archive.
	 * Returns the offset where the data will be located in the final tar.
	 */
	addEntry(filename: string, data: Uint8Array): number {
		// Offset is after header (512 bytes) from current position
		const offset = this.totalSize + BLOCK_SIZE;

		this.entries.push({ filename, data });

		// Update total size: header + padded data
		this.totalSize += BLOCK_SIZE + padToBlock(data).length;

		return offset;
	}

	/**
	 * Get the current total size (useful for checking against max packfile size)
	 */
	getCurrentSize(): number {
		// Add end-of-archive marker (2 zero blocks)
		return this.totalSize + 2 * BLOCK_SIZE;
	}

	/**
	 * Finalize and return the complete tar archive
	 */
	finalize(): Uint8Array {
		// Final size includes all entries plus two zero blocks at end
		const finalSize = this.totalSize + 2 * BLOCK_SIZE;
		const archive = new Uint8Array(finalSize);

		let position = 0;
		for (const entry of this.entries) {
			// Write header
			const header = createTarHeader(entry.filename, entry.data.length);
			archive.set(header, position);
			position += BLOCK_SIZE;

			// Write padded data
			const paddedData = padToBlock(entry.data);
			archive.set(paddedData, position);
			position += paddedData.length;
		}

		// Two zero blocks at end (already zeroed from Uint8Array initialization)

		return archive;
	}

	/**
	 * Get number of entries
	 */
	getEntryCount(): number {
		return this.entries.length;
	}
}

/**
 * Parse a tar header to extract filename and size
 */
function parseTarHeader(
	header: Uint8Array,
): { filename: string; size: number } | null {
	// Check if this is an empty block (end of archive)
	let isEmpty = true;
	for (let i = 0; i < BLOCK_SIZE; i++) {
		if (header[i] !== 0) {
			isEmpty = false;
			break;
		}
	}
	if (isEmpty) {
		return null;
	}

	const decoder = new TextDecoder();

	// Extract filename (first 100 bytes, null-terminated)
	let filenameEnd = 0;
	while (filenameEnd < 100 && header[filenameEnd] !== 0) {
		filenameEnd++;
	}
	const filename = decoder.decode(header.slice(0, filenameEnd));

	// Extract size (12 bytes at offset 124, octal, null-terminated)
	let sizeEnd = 124;
	while (sizeEnd < 136 && header[sizeEnd] !== 0 && header[sizeEnd] !== 32) {
		sizeEnd++;
	}
	const sizeStr = decoder.decode(header.slice(124, sizeEnd));
	const size = parseInt(sizeStr, 8);

	return { filename, size };
}

/**
 * Read entries from a tar archive
 */
export function* readTarEntries(archive: Uint8Array): Generator<TarEntry> {
	let position = 0;

	while (position + BLOCK_SIZE <= archive.length) {
		const header = archive.slice(position, position + BLOCK_SIZE);
		const parsed = parseTarHeader(header);

		if (!parsed) {
			// End of archive
			break;
		}

		const dataOffset = position + BLOCK_SIZE;
		const data = archive.slice(dataOffset, dataOffset + parsed.size);

		yield {
			filename: parsed.filename,
			data,
			offset: dataOffset,
		};

		// Move to next entry (header + padded data)
		const paddedSize = Math.ceil(parsed.size / BLOCK_SIZE) * BLOCK_SIZE;
		position = dataOffset + paddedSize;
	}
}

/**
 * Read a single entry at a known offset
 */
export function readTarEntryAtOffset(
	archive: Uint8Array,
	offset: number,
	size: number,
): Uint8Array {
	return archive.slice(offset, offset + size);
}
