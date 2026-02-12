import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { hash64ToHex } from "./packfile/hash";
import { PackfileWriter } from "./packfile/writer";

const DB_BATCH_SIZE = 50;

export class PackfileDO extends DurableObject<Env> {
	private writer: PackfileWriter | null = null;
	private sourceCode: string | null = null;

	private getWriter(sourceCode: string): PackfileWriter {
		if (!this.writer || this.sourceCode !== sourceCode) {
			this.sourceCode = sourceCode;
			this.writer = new PackfileWriter(sourceCode);
		}
		return this.writer;
	}

	async appendBlobs(
		sourceCode: string,
		sourceId: string,
		blobs: Array<{ hashHex: string; content: string }>,
	): Promise<void> {
		// Batch existence checks: 10 hashes per query, all queries at once
		const EXISTENCE_BATCH_SIZE = 10;
		const existingHashes = new Set<string>();

		const statements: D1PreparedStatement[] = [];
		for (let i = 0; i < blobs.length; i += EXISTENCE_BATCH_SIZE) {
			const chunk = blobs.slice(i, i + EXISTENCE_BATCH_SIZE);
			const placeholders = chunk.map(() => "?").join(", ");
			statements.push(
				this.env.DB.prepare(
					`SELECT hash FROM blobs WHERE source_id = ? AND hash IN (${placeholders})`,
				).bind(sourceId, ...chunk.map((b) => b.hashHex)),
			);
		}

		if (statements.length > 0) {
			const results = await this.env.DB.batch<{ hash: string }>(statements);
			for (const result of results) {
				for (const row of result.results) {
					existingHashes.add(row.hash);
				}
			}
		}

		const writer = this.getWriter(sourceCode);
		for (const blob of blobs) {
			if (!existingHashes.has(blob.hashHex)) {
				await writer.addBlob(new TextEncoder().encode(blob.content));
			}
		}
		await this.uploadFinished(sourceId);
	}

	async flush(sourceCode: string, sourceId: string): Promise<void> {
		const writer = this.getWriter(sourceCode);
		await writer.finalize();
		await this.uploadFinished(sourceId);
	}

	private async uploadFinished(sourceId: string): Promise<void> {
		if (!this.writer) return;
		const packfiles = this.writer.drainFinishedPackfiles();
		if (packfiles.length === 0) return;

		for (const packfile of packfiles) {
			await this.env.STORAGE.put(packfile.key, packfile.data);
			console.log(
				`[PackfileDO] Uploaded packfile ${packfile.key} (${packfile.data.length} bytes, ${packfile.entries.length} blobs)`,
			);

			for (let i = 0; i < packfile.entries.length; i += DB_BATCH_SIZE) {
				const batch = packfile.entries.slice(i, i + DB_BATCH_SIZE);
				const statements = batch.map((entry) =>
					this.env.DB.prepare(
						`INSERT OR IGNORE INTO blobs (hash, source_id, packfile_key, offset, size)
						 VALUES (?, ?, ?, ?, ?)`,
					).bind(
						hash64ToHex(entry.hash),
						sourceId,
						packfile.key,
						entry.offset,
						entry.size,
					),
				);
				await this.env.DB.batch(statements);
			}
		}
	}
}
