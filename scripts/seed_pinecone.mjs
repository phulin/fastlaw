import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_EMBED_ENDPOINT = "https://api.pinecone.io/embed";
const DEFAULT_INDEX_NAME = "cgs";
const DEFAULT_MODEL = "llama-text-embed-v2";
const CHUNK_SIZE = 2048;
const BATCH_SIZE = Number(process.env.PINECONE_BATCH_SIZE ?? "16");

const loadEnvFile = (envPath) => {
	if (!fs.existsSync(envPath)) return;
	const content = fs.readFileSync(envPath, "utf8");
	for (const line of content.split(/\r?\n/)) {
		if (!line || line.startsWith("#")) continue;
		const eqIndex = line.indexOf("=");
		if (eqIndex === -1) continue;
		const key = line.slice(0, eqIndex).trim();
		const value = line.slice(eqIndex + 1).trim();
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
};

loadEnvFile(path.resolve(".env"));

const apiKey = process.env.PINECONE_API_KEY;
const embedEndpoint =
	process.env.PINECONE_EMBED_ENDPOINT ?? DEFAULT_EMBED_ENDPOINT;
const indexName = process.env.PINECONE_INDEX_NAME ?? DEFAULT_INDEX_NAME;
const model = process.env.PINECONE_EMBED_MODEL ?? DEFAULT_MODEL;
const apiVersion = process.env.PINECONE_API_VERSION ?? "2025-04";
const embedDimension = Number(process.env.PINECONE_EMBED_DIMENSION ?? "2048");

if (!apiKey) {
	throw new Error("Missing PINECONE_API_KEY.");
}

const getIndexHost = async () => {
	const res = await fetch(`https://api.pinecone.io/indexes/${indexName}`, {
		headers: { "Api-Key": apiKey },
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Failed to fetch index host: ${res.status} ${text}`);
	}
	const body = await res.json();
	return body.host;
};

const embedBatch = async (texts) => {
	for (let attempt = 0; ; attempt += 1) {
		const res = await fetch(embedEndpoint, {
			method: "POST",
			headers: {
				"Api-Key": apiKey,
				"Content-Type": "application/json",
				"X-Pinecone-API-Version": apiVersion,
			},
			body: JSON.stringify({
				model,
				inputs: texts.map((text) => ({ text })),
				parameters: {
					input_type: "passage",
					truncate: "END",
					dimension: embedDimension,
				},
			}),
		});
		if (res.ok) {
			const body = await res.json();
			return body.data.map((item) => item.values);
		}
		if (res.status === 429) {
			const retryAfter = res.headers.get("retry-after");
			const delayMs = retryAfter
				? Number(retryAfter) * 1000
				: 60000 + attempt * 10000;
			console.log(
				`Rate limited by Pinecone. Waiting ${Math.round(delayMs / 1000)}s...`,
			);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			continue;
		}
		const text = await res.text();
		throw new Error(`Embedding failed: ${res.status} ${text}`);
	}
};

const upsertBatch = async (host, vectors) => {
	const res = await fetch(`https://${host}/vectors/upsert`, {
		method: "POST",
		headers: {
			"Api-Key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ vectors }),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Upsert failed: ${res.status} ${text}`);
	}
};

const chunkText = (text) => {
	const chunks = [];
	let offset = 0;
	while (offset < text.length) {
		const slice = text.slice(offset, offset + CHUNK_SIZE);
		chunks.push(slice.trim());
		offset += CHUNK_SIZE;
	}
	return chunks;
};

const buildSectionText = (row) => {
	const title = row.section_title ? ` - ${row.section_title}` : "";
	const header = `${row.section_label}${title}`;
	return `${header}\n\n${row.body}`;
};

const compactMetadata = (metadata) =>
	Object.fromEntries(
		Object.entries(metadata).filter(
			([, value]) => value !== null && value !== undefined,
		),
	);

const dbPath = path.resolve("cga_sections.sqlite3");
const db = new Database(dbPath, { readonly: true });

const stmt = db.prepare(
	`
  SELECT
    section_id,
    chapter_id,
    title_id,
    section_number,
    section_title,
    section_label,
    body,
    source_file
  FROM sections
  ORDER BY section_number
  `,
);

const sections = stmt.all().map((row) => {
	const text = buildSectionText(row);
	const chunks = chunkText(text);
	return { row, chunks };
});

const totalVectorsPlanned = sections.reduce(
	(sum, entry) => sum + entry.chunks.length,
	0,
);

const host = await getIndexHost();
console.log(`Using Pinecone index host: ${host}`);
console.log(`Preparing to upsert ${totalVectorsPlanned} vectors...`);

const formatSectionRange = (batch) => {
	const start =
		batch[0].metadata.section_label ?? batch[0].metadata.section_number;
	const end =
		batch[batch.length - 1].metadata.section_label ??
		batch[batch.length - 1].metadata.section_number;
	return start === end ? `${start}` : `${start}-${end}`;
};

const pending = [];
let totalVectors = 0;

for (const { row, chunks } of sections) {
	chunks.forEach((chunk, index) => {
		pending.push({
			id: `${row.section_id}::${index + 1}`,
			metadata: compactMetadata({
				section_id: row.section_id,
				chapter_id: row.chapter_id,
				title_id: row.title_id,
				section_number: row.section_number,
				section_label: row.section_label,
				section_title: row.section_title,
				source_file: row.source_file,
				chunk_index: index + 1,
				chunk_count: chunks.length,
				text: chunk,
			}),
		});
	});

	while (pending.length >= BATCH_SIZE) {
		const batch = pending.splice(0, BATCH_SIZE);
		const embeddings = await embedBatch(
			batch.map((item) => item.metadata.text),
		);
		const vectors = batch.map((item, idx) => ({
			id: item.id,
			values: embeddings[idx],
			metadata: item.metadata,
		}));
		await upsertBatch(host, vectors);
		totalVectors += vectors.length;
		const range = formatSectionRange(batch);
		console.log(
			`Upserted ${totalVectors}/${totalVectorsPlanned} vectors (sections ${range}).`,
		);
	}
}

if (pending.length > 0) {
	const embeddings = await embedBatch(
		pending.map((item) => item.metadata.text),
	);
	const vectors = pending.map((item, idx) => ({
		id: item.id,
		values: embeddings[idx],
		metadata: item.metadata,
	}));
	await upsertBatch(host, vectors);
	totalVectors += vectors.length;
	const range = formatSectionRange(pending);
	console.log(
		`Upserted ${totalVectors}/${totalVectorsPlanned} vectors (sections ${range}).`,
	);
}

db.close();
console.log(`Done. Total vectors upserted: ${totalVectors}`);
