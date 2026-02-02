import { parse as parseCSV } from "csv-parse/sync";
import type { Context } from "hono";
import { Hono } from "hono";
import type { DocData, LevelData } from "./App";
import { render } from "./entry-server";
import {
	getAncestorNodes,
	getChildNodes,
	getLatestSourceVersion,
	getNodeBySlug,
	getNodeContent,
	getSiblingNodes,
	getSourceByCode,
	setEnv,
} from "./lib/db";
import type { Env } from "./lib/types";
import { handleQuickSearch, handleSearch } from "./server/search";

type AppContext = {
	Bindings: Env & { ASSETS?: Fetcher };
};

const app = new Hono<AppContext>();

const isDocumentRoute = (pathname: string) =>
	pathname === "/statutes" ||
	pathname.startsWith("/statutes/") ||
	pathname === "/cases" ||
	pathname.startsWith("/cases/");

const isLevelRoute = (pathname: string) =>
	/^\/statutes\/[^/]+\/(title|chapter|part|subchapter)\/[^/]+$/.test(pathname);

const isAssetRequest = (pathname: string) =>
	pathname.startsWith("/assets/") ||
	pathname.startsWith("/src/") ||
	pathname.startsWith("/node_modules/") ||
	pathname.startsWith("/@vite/") ||
	pathname === "/@solid-refresh" ||
	pathname === "/favicon.ico" ||
	pathname === "/robots.txt" ||
	/\.[a-z0-9]+$/i.test(pathname);

const readTemplate = async (c: Context<AppContext>) => {
	const assets = c.env.ASSETS;
	if (!assets) return null;
	const url = new URL(c.req.url);
	url.pathname = "/index.html";
	url.search = "";
	const response = await assets.fetch(url.toString());
	if (!response.ok) return null;
	return response.text();
};

app.use("*", async (c, next) => {
	setEnv(c.env);
	await next();
});

app.options("/api/quicksearch", async (c) =>
	handleQuickSearch(c.req.raw, c.env),
);
app.post("/api/quicksearch", async (c) => handleQuickSearch(c.req.raw, c.env));
app.options("/api/search", async (c) => handleSearch(c.req.raw, c.env));
app.post("/api/search", async (c) => handleSearch(c.req.raw, c.env));

// CSV upload for nodes table (local dev only)
app.post("/api/upload-nodes", async (c) => {
	const formData = await c.req.formData();
	const file = formData.get("file");

	if (!file || !(file instanceof File)) {
		return c.json({ error: "No CSV file provided" }, 400);
	}

	const text = await file.text();

	type NodeRow = {
		id: string;
		source_version_id: string;
		string_id: string;
		parent_id: string;
		level_name: string;
		level_index: string;
		sort_order: string;
		label: string;
		name: string;
		slug: string;
		blob_key: string;
		blob_offset: string;
		blob_size: string;
		source_url: string;
		accessed_at: string;
	};

	let rows: NodeRow[];
	try {
		rows = parseCSV(text, {
			columns: true,
			skip_empty_lines: true,
			relax_column_count: false,
		}) as NodeRow[];
	} catch (err) {
		return c.json(
			{
				error: `CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
			},
			400,
		);
	}

	if (rows.length === 0) {
		return c.json({ error: "CSV must have at least one data row" }, 400);
	}

	// Validate required columns from first row
	const requiredColumns = [
		"source_version_id",
		"string_id",
		"level_name",
		"level_index",
		"sort_order",
	];
	const firstRowKeys = Object.keys(rows[0]);
	const missingColumns = requiredColumns.filter(
		(col) => !firstRowKeys.includes(col),
	);
	if (missingColumns.length > 0) {
		return c.json(
			{ error: `Missing required columns: ${missingColumns.join(", ")}` },
			400,
		);
	}

	const db = c.env.DB;
	let inserted = 0;
	const errors: string[] = [];

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		try {
			await db
				.prepare(`
				INSERT OR REPLACE INTO nodes (
					id, source_version_id, string_id, parent_id, level_name,
					level_index, sort_order, label, name, slug,
					blob_key, blob_offset, blob_size, source_url, accessed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
				.bind(
					row.id || null,
					row.source_version_id
						? Number.parseInt(row.source_version_id, 10)
						: null,
					row.string_id || null,
					row.parent_id || null,
					row.level_name || null,
					row.level_index ? Number.parseInt(row.level_index, 10) : 0,
					row.sort_order ? Number.parseInt(row.sort_order, 10) : 0,
					row.label || null,
					row.name || null,
					row.slug || null,
					row.blob_key || null,
					row.blob_offset ? Number.parseInt(row.blob_offset, 10) : null,
					row.blob_size ? Number.parseInt(row.blob_size, 10) : null,
					row.source_url || null,
					row.accessed_at || null,
				)
				.run();
			inserted++;
		} catch (err) {
			errors.push(
				`Row ${i + 2}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return c.json({
		success: true,
		inserted,
		total: rows.length,
		errors: errors.length > 0 ? errors : undefined,
	});
});

app.get("*", async (c) => {
	const url = new URL(c.req.url);
	if (isAssetRequest(url.pathname) && c.env.ASSETS) {
		const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
		if (assetResponse.status !== 404) return assetResponse;
	}

	const template = await readTemplate(c);
	if (!template) {
		return c.text("Missing HTML template.", 500);
	}

	let docData: DocData | null = null;
	let levelData: LevelData | null = null;

	// Parse URL to extract source code and node path
	// Format: /statutes/{source}/{level_name}/{slug} or /statutes/{source}/section/{title}/{section}
	const pathParts = url.pathname.replace(/^\/+/, "").split("/");
	const sourceCode = pathParts[1]; // e.g., "cgs", "usc"

	if (isLevelRoute(url.pathname) || isDocumentRoute(url.pathname)) {
		const slug = url.pathname.replace(/^\/+/, "");

		// Get source and version
		const source = sourceCode ? await getSourceByCode(sourceCode) : null;
		if (!source) {
			if (isLevelRoute(url.pathname)) {
				levelData = { status: "missing", slug };
			} else {
				docData = { status: "missing", slug };
			}
		} else {
			const sourceVersion = await getLatestSourceVersion(source.id);
			if (!sourceVersion) {
				if (isLevelRoute(url.pathname)) {
					levelData = { status: "missing", slug };
				} else {
					docData = { status: "missing", slug };
				}
			} else {
				// Build the node slug from path parts
				// For levels: /statutes/cgs/title/21 -> title/21
				// For sections: /statutes/cgs/section/21/1 -> section/21/1
				const nodeSlug = pathParts.slice(2).join("/");

				const node = await getNodeBySlug(sourceVersion.id, nodeSlug);
				if (!node) {
					if (isLevelRoute(url.pathname)) {
						levelData = { status: "missing", slug };
					} else {
						docData = { status: "missing", slug };
					}
				} else if (isLevelRoute(url.pathname)) {
					// Level route - show hierarchy
					const children = await getChildNodes(node.id);
					const ancestors = await getAncestorNodes(node.id);
					levelData = {
						status: "found",
						slug,
						node,
						source,
						sourceVersion,
						children,
						ancestors,
					};
				} else {
					// Document route - show content
					const content = await getNodeContent(node);
					if (!content) {
						docData = { status: "missing", slug };
					} else {
						const nav =
							node.parent_id != null
								? await getSiblingNodes(node.parent_id, node.sort_order)
								: null;
						const ancestors = await getAncestorNodes(node.id);
						docData = {
							status: "found",
							slug,
							node,
							content,
							nav,
							ancestors,
							source,
							sourceVersion,
						};
					}
				}
			}
		}
	}

	const rendered = render(url.pathname, docData, levelData);
	const ssrScript = "<script>window.__SSR__=true</script>";
	const docScript = docData
		? `<script>window.__DOC_DATA__=${JSON.stringify(docData)}</script>`
		: "";
	const levelScript = levelData
		? `<script>window.__LEVEL_DATA__=${JSON.stringify(levelData)}</script>`
		: "";
	const html = template
		.replace(
			"<!--app-head-->",
			`${rendered.head ?? ""}${ssrScript}${docScript}${levelScript}`,
		)
		.replace("<!--app-html-->", rendered.html ?? "");
	const status =
		docData?.status === "missing" || levelData?.status === "missing"
			? 404
			: 200;
	return c.html(html, status);
});

export default app;
