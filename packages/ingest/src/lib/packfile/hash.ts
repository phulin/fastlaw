import xxhash, { type XXHashAPI } from "xxhash-wasm";

let xxhashInstance: XXHashAPI | null = null;

async function getXXHash(): Promise<XXHashAPI> {
	if (!xxhashInstance) {
		xxhashInstance = await xxhash();
	}
	return xxhashInstance;
}

/**
 * Compute xxhash64 of data, returning as bigint
 */
export async function hash64(data: Uint8Array): Promise<bigint> {
	const h = await getXXHash();
	return h.h64Raw(data);
}

/**
 * Convert a 64-bit hash bigint to a hex string
 */
export function hash64ToHex(hash: bigint): string {
	return hash.toString(16).padStart(16, "0");
}

/**
 * Convert a 64-bit hash bigint to 8 bytes as Uint8Array
 * (for embedding in packfile entries as verification)
 */
export function hash64ToPrefix(hash: bigint): Uint8Array {
	const bytes = new Uint8Array(8);
	for (let i = 0; i < 8; i += 1) {
		const shift = BigInt(56 - i * 8);
		bytes[i] = Number((hash >> shift) & 0xffn);
	}
	return bytes;
}

/**
 * Verify that an 8-byte prefix matches a hash
 */
export function verifyHashPrefix(prefix: Uint8Array, hash: bigint): boolean {
	const expected = hash64ToPrefix(hash);
	return (
		prefix[0] === expected[0] &&
		prefix[1] === expected[1] &&
		prefix[2] === expected[2] &&
		prefix[3] === expected[3]
	);
}

/**
 * Convert a 64-bit hash bigint to a signed 64-bit integer for SQLite storage.
 * SQLite stores integers as signed, so we need to handle the conversion.
 */
export function hash64ToSqliteInt(hash: bigint): bigint {
	// If the high bit is set, convert to negative (two's complement)
	if (hash >= 0x8000000000000000n) {
		return hash - 0x10000000000000000n;
	}
	return hash;
}

/**
 * Convert a signed 64-bit integer from SQLite back to unsigned bigint
 */
export function sqliteIntToHash64(sqliteInt: bigint): bigint {
	if (sqliteInt < 0n) {
		return sqliteInt + 0x10000000000000000n;
	}
	return sqliteInt;
}
