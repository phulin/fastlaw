/// <reference types="node" />

import { Readable } from "node:stream";
import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import type {
	ObjectStore,
	ObjectStoreBody,
	ObjectStoreGetOptions,
	ObjectStoreListResult,
} from "../../types";

class S3ObjectBody implements ObjectStoreBody {
	private data: Uint8Array;

	constructor(data: Uint8Array) {
		this.data = data;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.data.slice().buffer;
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(this.data);
	}
}

class S3ObjectStore implements ObjectStore {
	private client: S3Client;
	private bucket: string;

	constructor(client: S3Client, bucket: string) {
		this.client = client;
		this.bucket = bucket;
	}

	async get(
		key: string,
		options?: ObjectStoreGetOptions,
	): Promise<ObjectStoreBody | null> {
		const range = options?.range
			? `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`
			: undefined;
		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Range: range,
			}),
		);

		if (!response.Body) {
			return null;
		}

		const data = await bodyToUint8Array(response.Body);
		return new S3ObjectBody(data);
	}

	async put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
	): Promise<void> {
		const body =
			typeof value === "string"
				? value
				: value instanceof Uint8Array
					? value
					: new Uint8Array(value);
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: body,
			}),
		);
	}

	async list(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<ObjectStoreListResult> {
		const response = await this.client.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: options?.prefix,
				MaxKeys: options?.limit,
				ContinuationToken: options?.cursor,
			}),
		);

		const contents = response.Contents ?? [];
		return {
			objects: contents.map(
				(obj: {
					Key?: string;
					Size?: number;
					ETag?: string;
					LastModified?: Date;
				}) => ({
					key: obj.Key ?? "",
					size: obj.Size ?? 0,
					etag: obj.ETag?.replace(/"/g, "") ?? "",
					uploaded: obj.LastModified?.toISOString() ?? "",
				}),
			),
			truncated: response.IsTruncated ?? false,
			cursor: response.NextContinuationToken,
		};
	}

	async delete(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		await this.client.send(
			new DeleteObjectsCommand({
				Bucket: this.bucket,
				Delete: {
					Objects: keys.map((key) => ({ Key: key })),
				},
			}),
		);
	}
}

async function bodyToUint8Array(
	body: Readable | ReadableStream | Blob | Uint8Array,
): Promise<Uint8Array> {
	if (body instanceof Uint8Array) {
		return body;
	}
	if (body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	if (body instanceof Readable) {
		const chunks: Buffer[] = [];
		for await (const chunk of body) {
			chunks.push(Buffer.from(chunk));
		}
		return new Uint8Array(Buffer.concat(chunks));
	}
	if ("getReader" in body) {
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let totalLength = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.length;
		}
		const merged = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		return merged;
	}
	return new Uint8Array();
}

export function createS3ObjectStore(env: {
	CF_ACCOUNT_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_BUCKET_NAME: string;
}): ObjectStore {
	const client = new S3Client({
		region: "auto",
		endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		},
	});
	return new S3ObjectStore(client, env.R2_BUCKET_NAME);
}
