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
		blobs: Array<{ hashHex: string; content: number[] }>,
	): Promise<void> {
		const writer = this.getWriter(sourceCode);
		for (const blob of blobs) {
			await writer.addBlob(new Uint8Array(blob.content));
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
