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
 * Convert a 64-bit hash bigint to a hex string (16 chars)
 */
export function hash64ToHex(hash: bigint): string {
	return hash.toString(16).padStart(16, "0");
}

/**
 * Convert a 16-char hex string back to a 64-bit hash bigint
 */
export function hexToHash64(hex: string): bigint {
	return BigInt(`0x${hex}`);
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
