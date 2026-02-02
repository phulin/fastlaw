import type { Context } from "hono";
import { Hono } from "hono";
import type { DocData, LevelData } from "./App";
import { render } from "./entry-server";
import {
	getAncestorLevels,
	getDocumentBySlug,
	getDocumentContent,
	getLevelByDocId,
	getLevelBySlug,
	getLevelsByParentId,
	getSiblingLevels,
	getSourceById,
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

	if (isLevelRoute(url.pathname)) {
		const slug = url.pathname.replace(/^\/+/, "");
		const level = await getLevelBySlug(slug);
		if (!level) {
			levelData = { status: "missing", slug };
		} else {
			const source = await getSourceById(level.source_id);
			if (!source) {
				levelData = { status: "missing", slug };
			} else {
				const children = await getLevelsByParentId(
					level.source_id,
					level.doc_type,
					level.id,
				);
				const ancestors = await getAncestorLevels(level.id);
				levelData = {
					status: "found",
					slug,
					level,
					source,
					children,
					ancestors,
				};
			}
		}
	} else if (isDocumentRoute(url.pathname)) {
		const slug = url.pathname.replace(/^\/+/, "");
		const doc = await getDocumentBySlug(slug);
		if (!doc) {
			docData = { status: "missing", slug };
		} else {
			const content = await getDocumentContent(slug);
			if (!content) {
				docData = { status: "missing", slug };
			} else {
				const level = await getLevelByDocId(doc.id);
				const nav =
					level?.parent_id != null
						? await getSiblingLevels(level.parent_id, level.sort_order)
						: null;
				const ancestors = level ? await getAncestorLevels(level.id) : null;
				const source = await getSourceById(doc.source_id);
				docData = {
					status: "found",
					slug,
					doc,
					content,
					level,
					nav,
					ancestors,
					source,
				};
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
