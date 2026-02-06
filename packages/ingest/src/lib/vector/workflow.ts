import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Env, VectorWorkflowParams } from "../../types";
import { readBlobJson } from "../packfile";

const DEFAULT_SOURCE_ID = "cgs";
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 20;
const QUICK_MAX_CHARS = 1400;
const TOOL_CHUNK_CHARS = 1200;
const TOOL_MAX_CHUNKS = 3;
const QUICK_VECTOR_SUFFIX = "#quick";
const TOOL_VECTOR_SUFFIX = "#tool";

interface SourceVersionRow {
	id: string;
}

interface SectionNodeRow {
	id: string;
	source_version_id: string;
	readable_id: string | null;
	heading_citation: string | null;
	name: string | null;
	path: string | null;
	blob_hash: string;
}

interface BlobLocationRow {
	packfile_key: string;
	offset: number;
	size: number;
}

interface ContentBlock {
	type: string;
	label?: string;
	content: string;
}

interface StoredNodeContent {
	blocks: ContentBlock[];
}

interface PreparedSection {
	node: SectionNodeRow;
	quickText: string;
	quickSnippet: string;
	toolChunks: string[];
}

interface BatchResult {
	done: boolean;
	nextCursor: string | null;
	sectionsProcessed: number;
	quickVectorsUpserted: number;
	toolVectorsUpserted: number;
}

export interface VectorWorkflowResult {
	sourceVersionId: string;
	sourceId: string;
	sectionsProcessed: number;
	quickVectorsUpserted: number;
	toolVectorsUpserted: number;
	totalSections: number;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trim()}...`;
}

function splitIntoChunks(text: string, chunkChars: number): string[] {
	const normalized = collapseWhitespace(text);
	if (!normalized) {
		return [];
	}

	const chunks: string[] = [];
	let start = 0;
	while (start < normalized.length && chunks.length < TOOL_MAX_CHUNKS) {
		const end = Math.min(start + chunkChars, normalized.length);
		chunks.push(normalized.slice(start, end).trim());
		start = end;
	}
	return chunks.filter((chunk) => chunk.length > 0);
}

function formatBlock(block: ContentBlock): string {
	if (!block.content) {
		return "";
	}
	if (block.label) {
		return `${block.label}: ${block.content}`;
	}
	return block.content;
}

function extractContentText(content: StoredNodeContent): string {
	return content.blocks
		.map((block) => formatBlock(block))
		.filter((block) => block.length > 0)
		.join("\n\n");
}

function createQuickText(node: SectionNodeRow, body: string): string {
	const heading = [node.heading_citation, node.name]
		.filter((value): value is string => Boolean(value))
		.join(" - ");
	const combined = heading ? `${heading}\n\n${body}` : body;
	return truncateChars(collapseWhitespace(combined), QUICK_MAX_CHARS);
}

function createToolText(node: SectionNodeRow, body: string): string {
	const heading = [node.heading_citation, node.name]
		.filter((value): value is string => Boolean(value))
		.join("\n");
	return heading ? `${heading}\n\n${body}` : body;
}

async function resolveSourceVersionId(
	env: Env,
	sourceVersionId?: string,
	sourceId?: string,
): Promise<{ sourceVersionId: string; sourceId: string }> {
	if (sourceVersionId) {
		const record = await env.DB.prepare(
			"SELECT source_id FROM source_versions WHERE id = ? LIMIT 1",
		)
			.bind(sourceVersionId)
			.first<{ source_id: string }>();
		if (!record) {
			throw new Error(`Unknown source version: ${sourceVersionId}`);
		}
		return { sourceVersionId, sourceId: record.source_id };
	}

	const effectiveSourceId = sourceId ?? DEFAULT_SOURCE_ID;
	const latest = await env.DB.prepare(
		`SELECT id
		 FROM source_versions
		 WHERE source_id = ?
		 ORDER BY version_date DESC
		 LIMIT 1`,
	)
		.bind(effectiveSourceId)
		.first<SourceVersionRow>();

	if (!latest) {
		throw new Error(
			`No source version found for source "${effectiveSourceId}"`,
		);
	}

	return {
		sourceVersionId: latest.id,
		sourceId: effectiveSourceId,
	};
}

async function loadSectionBatch(args: {
	env: Env;
	sourceVersionId: string;
	cursor: string | null;
	batchSize: number;
}): Promise<SectionNodeRow[]> {
	const { env, sourceVersionId, cursor, batchSize } = args;
	if (cursor) {
		const result = await env.DB.prepare(
			`SELECT id, source_version_id, readable_id, heading_citation, name, path, blob_hash
			 FROM nodes
			 WHERE source_version_id = ?
			   AND level_name = 'section'
			   AND blob_hash IS NOT NULL
			   AND id > ?
			 ORDER BY id ASC
			 LIMIT ?`,
		)
			.bind(sourceVersionId, cursor, batchSize)
			.all<SectionNodeRow>();
		return result.results;
	}

	const result = await env.DB.prepare(
		`SELECT id, source_version_id, readable_id, heading_citation, name, path, blob_hash
		 FROM nodes
		 WHERE source_version_id = ?
		   AND level_name = 'section'
		   AND blob_hash IS NOT NULL
		 ORDER BY id ASC
		 LIMIT ?`,
	)
		.bind(sourceVersionId, batchSize)
		.all<SectionNodeRow>();
	return result.results;
}

async function loadBlobLocation(
	env: Env,
	hash: string,
): Promise<BlobLocationRow | null> {
	return await env.DB.prepare(
		"SELECT packfile_key, offset, size FROM blobs WHERE hash = ? LIMIT 1",
	)
		.bind(hash)
		.first<BlobLocationRow>();
}

async function prepareSection(
	env: Env,
	node: SectionNodeRow,
): Promise<PreparedSection | null> {
	const location = await loadBlobLocation(env, node.blob_hash);
	if (!location) {
		return null;
	}

	const content = await readBlobJson<StoredNodeContent>(
		env.STORAGE,
		{
			packfileKey: location.packfile_key,
			offset: location.offset,
			size: location.size,
		},
		node.blob_hash,
	);

	const body = collapseWhitespace(extractContentText(content));
	if (!body) {
		return null;
	}

	const quickText = createQuickText(node, body);
	const toolText = createToolText(node, body);
	const toolChunks = splitIntoChunks(toolText, TOOL_CHUNK_CHARS);

	return {
		node,
		quickText,
		quickSnippet: truncateChars(quickText, 260),
		toolChunks,
	};
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	if (texts.length === 0) {
		return [];
	}

	const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
		text: texts,
		pooling: "cls",
	});

	const vectors = "data" in response ? response.data : undefined;
	if (!vectors || vectors.length !== texts.length) {
		throw new Error("Embedding response did not match input size.");
	}
	return vectors;
}

function getBatchSize(value: number | undefined): number {
	if (!value || Number.isNaN(value)) {
		return DEFAULT_BATCH_SIZE;
	}
	return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(value)));
}

async function runBatch(args: {
	env: Env;
	sourceVersionId: string;
	cursor: string | null;
	batchSize: number;
}): Promise<BatchResult> {
	const { env, sourceVersionId, cursor, batchSize } = args;
	const nodes = await loadSectionBatch({
		env,
		sourceVersionId,
		cursor,
		batchSize,
	});

	if (nodes.length === 0) {
		return {
			done: true,
			nextCursor: cursor,
			sectionsProcessed: 0,
			quickVectorsUpserted: 0,
			toolVectorsUpserted: 0,
		};
	}

	const prepared = (
		await Promise.all(nodes.map((node) => prepareSection(env, node)))
	).filter((item): item is PreparedSection => item !== null);

	const quickTexts = prepared.map((item) => item.quickText);
	const quickEmbeddings = await embedTexts(env, quickTexts);

	const quickVectors: VectorizeVector[] = prepared.map((item, index) => ({
		id: `${item.node.id}${QUICK_VECTOR_SUFFIX}`,
		values: quickEmbeddings[index],
		metadata: {
			source_version_id: item.node.source_version_id,
			node_id: item.node.id,
			readable_id: item.node.readable_id ?? "",
			heading_citation: item.node.heading_citation ?? "",
			name: item.node.name ?? "",
			path: item.node.path ?? "",
			text: item.quickSnippet,
		},
	}));

	const toolSources = prepared.flatMap((item) =>
		item.toolChunks.map((chunk, chunkIndex) => ({
			node: item.node,
			chunk,
			chunkIndex,
			chunkCount: item.toolChunks.length,
		})),
	);

	const toolEmbeddings = await embedTexts(
		env,
		toolSources.map((item) => item.chunk),
	);
	const toolVectors: VectorizeVector[] = toolSources.map((item, index) => ({
		id: `${item.node.id}${TOOL_VECTOR_SUFFIX}-${item.chunkIndex + 1}`,
		values: toolEmbeddings[index],
		metadata: {
			source_version_id: item.node.source_version_id,
			node_id: item.node.id,
			readable_id: item.node.readable_id ?? "",
			heading_citation: item.node.heading_citation ?? "",
			name: item.node.name ?? "",
			path: item.node.path ?? "",
			chunk_index: item.chunkIndex + 1,
			chunk_count: item.chunkCount,
			text: item.chunk,
		},
	}));

	if (quickVectors.length > 0) {
		await env.VECTOR_SEARCH_INDEX.upsert(quickVectors);
	}
	if (toolVectors.length > 0) {
		await env.VECTOR_SEARCH_INDEX.upsert(toolVectors);
	}

	const nextCursor = nodes[nodes.length - 1]?.id ?? cursor;
	return {
		done: false,
		nextCursor,
		sectionsProcessed: prepared.length,
		quickVectorsUpserted: quickVectors.length,
		toolVectorsUpserted: toolVectors.length,
	};
}

export class VectorIngestWorkflow extends WorkflowEntrypoint<
	Env,
	VectorWorkflowParams
> {
	async run(
		event: WorkflowEvent<VectorWorkflowParams>,
		step: WorkflowStep,
	): Promise<VectorWorkflowResult> {
		const config = await step.do("resolve-version", async () => {
			return await resolveSourceVersionId(
				this.env,
				event.payload.sourceVersionId,
				event.payload.sourceId,
			);
		});

		const batchSize = getBatchSize(event.payload.batchSize);
		const totalSectionsRecord = await step.do("count-sections", async () => {
			return await this.env.DB.prepare(
				`SELECT COUNT(*) as count
				 FROM nodes
				 WHERE source_version_id = ?
				   AND level_name = 'section'
				   AND blob_hash IS NOT NULL`,
			)
				.bind(config.sourceVersionId)
				.first<{ count: number }>();
		});

		let cursor: string | null = null;
		let batchIndex = 0;
		let sectionsProcessed = 0;
		let quickVectorsUpserted = 0;
		let toolVectorsUpserted = 0;

		while (true) {
			const result = await step.do(`batch-${batchIndex}`, async () => {
				return await runBatch({
					env: this.env,
					sourceVersionId: config.sourceVersionId,
					cursor,
					batchSize,
				});
			});

			if (result.sectionsProcessed > 0) {
				sectionsProcessed += result.sectionsProcessed;
				quickVectorsUpserted += result.quickVectorsUpserted;
				toolVectorsUpserted += result.toolVectorsUpserted;
			}

			if (result.done) {
				break;
			}

			cursor = result.nextCursor;
			batchIndex += 1;
		}

		return {
			sourceVersionId: config.sourceVersionId,
			sourceId: config.sourceId,
			sectionsProcessed,
			quickVectorsUpserted,
			toolVectorsUpserted,
			totalSections: totalSectionsRecord?.count ?? 0,
		};
	}
}
