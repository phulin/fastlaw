import { GoogleGenAI } from "@google/genai";
import type { Env } from "~/lib/types";

interface PineconeMatch {
	id: string;
	score: number;
	metadata?: Record<string, string | number | null>;
}

interface TraceEntry {
	tool: string;
	detail: string;
	input?: unknown;
	output?: unknown;
}

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

let cachedIndexHost = "";

const defaultReadTokens = 600;

const callGemini = async (
	apiKey: string,
	model: string,
	contents: string,
): Promise<string> => {
	const client = new GoogleGenAI({ apiKey });
	const response = await client.models.generateContent({
		model,
		contents,
		config: {
			temperature: 0.2,
			maxOutputTokens: 800,
		},
	});
	return response.text ?? "";
};

const getIndexHost = async (
	env: Env,
	indexName: string,
	apiKey: string,
): Promise<string> => {
	if (env.PINECONE_INDEX_HOST) return env.PINECONE_INDEX_HOST;
	if (cachedIndexHost) return cachedIndexHost;
	const res = await fetch(`https://api.pinecone.io/indexes/${indexName}`, {
		headers: { "Api-Key": apiKey },
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Pinecone index lookup failed: ${res.status} ${text}`);
	}
	const body = (await res.json()) as { host: string };
	cachedIndexHost = body.host;
	return cachedIndexHost;
};

const embedQuery = async (
	query: string,
	apiKey: string,
	apiVersion: string,
	embedEndpoint: string,
	embedModel: string,
	embedDimension: number,
): Promise<number[]> => {
	const res = await fetch(embedEndpoint, {
		method: "POST",
		headers: {
			"Api-Key": apiKey,
			"Content-Type": "application/json",
			"X-Pinecone-API-Version": apiVersion,
		},
		body: JSON.stringify({
			model: embedModel,
			inputs: [{ text: query }],
			parameters: {
				input_type: "query",
				truncate: "END",
				dimension: embedDimension,
			},
		}),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Pinecone embed failed: ${res.status} ${text}`);
	}
	const body = (await res.json()) as { data: Array<{ values: number[] }> };
	return body.data[0].values;
};

const queryIndex = async (
	host: string,
	apiKey: string,
	vector: number[],
	topK: number,
	namespace?: string,
): Promise<PineconeMatch[]> => {
	const payload: Record<string, unknown> = {
		vector,
		topK,
		includeMetadata: true,
	};
	if (namespace) payload.namespace = namespace;
	const res = await fetch(`https://${host}/query`, {
		method: "POST",
		headers: {
			"Api-Key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Pinecone query failed: ${res.status} ${text}`);
	}
	const body = (await res.json()) as { matches: PineconeMatch[] };
	return body.matches;
};

const fetchVectors = async (
	host: string,
	apiKey: string,
	ids: string[],
	namespace?: string,
): Promise<
	Record<
		string,
		{ id: string; metadata?: Record<string, string | number | null> }
	>
> => {
	const payload: Record<string, unknown> = { ids, includeMetadata: true };
	if (namespace) payload.namespace = namespace;
	const res = await fetch(`https://${host}/vectors/fetch`, {
		method: "POST",
		headers: {
			"Api-Key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Pinecone fetch failed: ${res.status} ${text}`);
	}
	const text = await res.text();
	if (!text) return {};
	const body = JSON.parse(text) as {
		vectors: Record<
			string,
			{ id: string; metadata?: Record<string, string | number | null> }
		>;
	};
	return body.vectors;
};

const limitTokens = (text: string, maxTokens: number): string => {
	const tokens = text.trim().split(/\s+/);
	if (tokens.length <= maxTokens) return text.trim();
	return `${tokens.slice(0, maxTokens).join(" ")}...`;
};

const extractJson = (raw: string): Record<string, unknown> | null => {
	if (!raw) return null;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	const slice = raw.slice(start, end + 1);
	try {
		return JSON.parse(slice) as Record<string, unknown>;
	} catch {
		return null;
	}
};

const buildAgentPrompt = ({
	query,
	history,
	observations,
}: {
	query: string;
	history: Array<{ role: string; content: string }>;
	observations: string[];
}): string => {
	const historyText = history
		.map(
			(item) =>
				`${item.role === "user" ? "User" : "Assistant"}: ${item.content}`,
		)
		.join("\n");
	const observationsText = observations.length
		? observations.join("\n")
		: "None.";
	return `You are a legal research agent for Connecticut General Statutes.
You may call tools or provide a final answer.

Tools:
1) semantic_search(query, topK) -> returns matches with id, score, section_label, section_title, snippet
2) read_statute(ids, maxTokens) -> returns statute texts for the ids, trimmed to maxTokens

Rules:
- Respond with JSON only.
- For tool calls, use {"type":"tool","tool":"semantic_search","args":{"query":"...","topK":6}}
  or {"type":"tool","tool":"read_statute","args":{"ids":["..."],"maxTokens":600}}.
- For final answers, use {"type":"final","answer":"..."}.
- Cite sources with brackets like [secs_01-1] using ids from read_statute.
- Do not include reasoning or extra text outside JSON.

Conversation:
${historyText || `User: ${query}`}

Question: ${query}

Tool observations:
${observationsText}
`;
};

interface AgentAction {
	type: "final" | "tool";
	answer?: string;
	tool?: string;
	args?: Record<string, unknown>;
}

const parseAgentAction = (raw: string): AgentAction | null => {
	const parsed = extractJson(raw);
	if (!parsed) return null;
	const type = String(parsed.type ?? "");
	if (type === "final") {
		return { type: "final", answer: String(parsed.answer ?? "") };
	}
	if (type === "tool") {
		return {
			type: "tool",
			tool: String(parsed.tool ?? ""),
			args: (parsed.args ?? {}) as Record<string, unknown>,
		};
	}
	return null;
};

const compactMatches = (matches: PineconeMatch[]) =>
	matches.map((match) => {
		const metadata = match.metadata ?? {};
		const label =
			metadata.section_label ?? metadata.section_number ?? "Section";
		const title = metadata.section_title ? ` - ${metadata.section_title}` : "";
		const text = typeof metadata.text === "string" ? metadata.text : "";
		const snippet = text.slice(0, 160);
		return {
			id: match.id,
			score: Number(match.score.toFixed(4)),
			label: `${label}${title}`,
			snippet,
		};
	});

export async function handleQuickSearch(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders });
	}

	try {
		const body = (await request.json()) as { query?: string; topK?: number };
		const query = String(body.query ?? "").trim();
		if (!query) {
			return new Response(JSON.stringify({ error: "Missing query" }), {
				status: 400,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		const apiKey = env.PINECONE_API_KEY;
		const indexName = env.PINECONE_INDEX_NAME ?? "cgs";
		const apiVersion = env.PINECONE_API_VERSION ?? "2025-04";
		const embedEndpoint =
			env.PINECONE_EMBED_ENDPOINT ?? "https://api.pinecone.io/embed";
		const embedModel = env.PINECONE_EMBED_MODEL ?? "llama-text-embed-v2";
		const embedDimension = Number(env.PINECONE_EMBED_DIMENSION ?? "2048");
		const topK = Number(body.topK ?? env.PINECONE_TOP_K ?? "10");

		const host = await getIndexHost(env, indexName, apiKey);
		const vector = await embedQuery(
			query,
			apiKey,
			apiVersion,
			embedEndpoint,
			embedModel,
			embedDimension,
		);
		const matches = await queryIndex(
			host,
			apiKey,
			vector,
			topK,
			env.PINECONE_NAMESPACE,
		);

		// Deduplicate by section_id, keeping highest score per section
		const seenSections = new Map<string, PineconeMatch>();
		for (const match of matches) {
			const sectionId = String(match.metadata?.section_id ?? match.id);
			const existing = seenSections.get(sectionId);
			if (!existing || match.score > existing.score) {
				seenSections.set(sectionId, match);
			}
		}

		const results = Array.from(seenSections.values()).map((match) => ({
			id: match.id,
			score: match.score,
			section_id: match.metadata?.section_id ?? null,
			section_label: match.metadata?.section_label ?? null,
			section_number: match.metadata?.section_number ?? null,
			section_title: match.metadata?.section_title ?? null,
			chapter_id: match.metadata?.chapter_id ?? null,
			title_id: match.metadata?.title_id ?? null,
			text: match.metadata?.text ?? null,
		}));

		return new Response(JSON.stringify({ query, results }), {
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
			}),
			{
				status: 500,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			},
		);
	}
}

export async function handleSearch(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders });
	}

	const stream = new TransformStream();
	const writer = stream.writable.getWriter();
	const encoder = new TextEncoder();

	const sendEvent = async (event: string, data: unknown) => {
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		await writer.write(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
	};

	const headers = {
		...corsHeaders,
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	};

	const body = (await request.json()) as {
		query?: string;
		topK?: number;
		readTokens?: number;
		maxSteps?: number;
		history?: Array<{ role: string; content: string }>;
	};

	(async () => {
		let trace: TraceEntry[] = [];
		try {
			trace = [];
			await sendEvent("status", "started");
			const query = String(body.query ?? "").trim();
			const apiKey = env.PINECONE_API_KEY;
			const indexName = env.PINECONE_INDEX_NAME ?? "cgs";
			const apiVersion = env.PINECONE_API_VERSION ?? "2025-04";
			const embedEndpoint =
				env.PINECONE_EMBED_ENDPOINT ?? "https://api.pinecone.io/embed";
			const embedModel = env.PINECONE_EMBED_MODEL ?? "llama-text-embed-v2";
			const embedDimension = Number(env.PINECONE_EMBED_DIMENSION ?? "2048");
			const topK = Number(body.topK ?? env.PINECONE_TOP_K ?? "6");
			const llmModel = env.GEMINI_MODEL;

			if (!env.GEMINI_API_KEY) {
				throw new Error("Missing GEMINI_API_KEY.");
			}
			if (!llmModel) {
				throw new Error("Missing GEMINI_MODEL.");
			}

			const readTokenLimit = Number(
				body.readTokens ?? env.READ_MAX_TOKENS ?? defaultReadTokens,
			);
			const maxSteps = Number(body.maxSteps ?? env.AGENT_MAX_STEPS ?? "6");

			const history = Array.isArray(body.history) ? body.history : [];
			const searches: string[] = [];
			const observations: string[] = [];
			const matchesById = new Map<string, PineconeMatch>();
			const readById = new Map<
				string,
				{ id: string; label: string; text: string }
			>();
			let answer = "";

			const host = await getIndexHost(env, indexName, apiKey);

			for (let step = 0; step < maxSteps; step += 1) {
				const prompt = buildAgentPrompt({ query, history, observations });
				const raw = await callGemini(env.GEMINI_API_KEY, llmModel, prompt);
				const action = parseAgentAction(raw);

				if (!action) {
					throw new Error("Agent returned invalid JSON.");
				}

				if (action.type === "final") {
					answer = action.answer ?? "";
					const entry = {
						tool: "final",
						detail: `answer_chars=${answer.length}`,
					};
					trace.push(entry);
					await sendEvent("trace", entry);
					break;
				}

				if (action.tool === "semantic_search") {
					const toolQuery = String(action.args?.query ?? query).trim();
					const toolTopK = Number(action.args?.topK ?? topK);
					const vector = await embedQuery(
						toolQuery,
						apiKey,
						apiVersion,
						embedEndpoint,
						embedModel,
						embedDimension,
					);
					const matches = await queryIndex(
						host,
						apiKey,
						vector,
						toolTopK,
						env.PINECONE_NAMESPACE,
					);
					matches.forEach((match) => {
						const existing = matchesById.get(match.id);
						if (!existing || existing.score < match.score) {
							matchesById.set(match.id, match);
						}
					});
					searches.push(toolQuery);
					const compact = compactMatches(matches);
					observations.push(
						`semantic_search(${toolQuery}) => ${JSON.stringify(compact)}`,
					);
					const entry = {
						tool: "semantic_search",
						detail: `query="${toolQuery}", topK=${toolTopK}, matches=${matches.length}`,
						input: { query: toolQuery, topK: toolTopK },
						output: compact,
					};
					trace.push(entry);
					await sendEvent("trace", entry);
					continue;
				}

				if (action.tool === "read_statute") {
					const ids = Array.isArray(action.args?.ids)
						? (action.args.ids as string[]).map(String)
						: [];
					const maxTokens = Number(action.args?.maxTokens ?? readTokenLimit);
					const fetched = await fetchVectors(
						host,
						apiKey,
						ids,
						env.PINECONE_NAMESPACE,
					);
					const reads = ids
						.map((id) => {
							const match = matchesById.get(id);
							const metadata = match?.metadata ?? fetched?.[id]?.metadata ?? {};
							const label =
								metadata.section_label ?? metadata.section_number ?? "Section";
							const title = metadata.section_title
								? ` - ${metadata.section_title}`
								: "";
							const text =
								typeof metadata.text === "string" ? metadata.text : "";
							return {
								id: (metadata.section_id as string) ?? id,
								label: `${label}${title}`,
								text: limitTokens(text, maxTokens),
							};
						})
						.filter((read) => read.text);
					reads.forEach((read) => {
						readById.set(read.id, read);
					});
					observations.push(
						`read_statute(${ids.join(", ")}) => ${JSON.stringify(reads)}`,
					);
					const entry = {
						tool: "read_statute",
						detail: `ids=${ids.length}, maxTokens=${maxTokens}`,
						input: { ids, maxTokens },
						output: reads,
					};
					trace.push(entry);
					await sendEvent("trace", entry);
					continue;
				}

				throw new Error(`Unknown tool requested: ${action.tool}`);
			}

			if (!answer) {
				throw new Error("Agent did not provide a final answer.");
			}

			const matches = Array.from(matchesById.values())
				.sort((left, right) => right.score - left.score)
				.slice(0, Math.max(8, topK));
			const reads = Array.from(readById.values());
			const steps = trace.map((item) => ({
				name: item.tool,
				detail: item.detail,
			}));

			await sendEvent("final", {
				query,
				searches,
				read_ids: reads.map((read) => read.id),
				reads,
				answer,
				steps,
				trace,
				citations: matches.map((match) => ({
					id: match.id,
					score: match.score,
					section_id: match.metadata?.section_id ?? null,
					section_label: match.metadata?.section_label ?? null,
					section_number: match.metadata?.section_number ?? null,
					section_title: match.metadata?.section_title ?? null,
					chapter_id: match.metadata?.chapter_id ?? null,
					title_id: match.metadata?.title_id ?? null,
					text: match.metadata?.text ?? null,
				})),
			});
			await sendEvent("done", "ok");
		} catch (error) {
			await sendEvent("error", {
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : null,
				trace,
			});
		} finally {
			await writer.close();
		}
	})();

	return new Response(stream.readable, { headers });
}
