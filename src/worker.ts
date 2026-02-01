import type { Context } from "hono";
import { Hono } from "hono";
import type { DocData } from "./App";
import { render } from "./entry-server";
import { getDocumentBySlug, setEnv } from "./lib/db";
import type { Env } from "./lib/types";
import { handleSearch } from "./server/search";

type AppContext = {
	Bindings: Env & { ASSETS?: Fetcher };
};

const app = new Hono<AppContext>();

const isDocumentRoute = (pathname: string) =>
	pathname === "/statutes" ||
	pathname.startsWith("/statutes/") ||
	pathname === "/cases" ||
	pathname.startsWith("/cases/");

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
	if (isDocumentRoute(url.pathname)) {
		const slug = url.pathname.replace(/^\/+/, "");
		const doc = await getDocumentBySlug(slug);
		docData = {
			status: doc ? "found" : "missing",
			slug,
		};
	}

	const rendered = render(url.pathname, docData);
	const ssrScript = "<script>window.__SSR__=true</script>";
	const docScript = docData
		? `<script>window.__DOC_DATA__=${JSON.stringify(docData)}</script>`
		: "";
	const html = template
		.replace(
			"<!--app-head-->",
			`${rendered.head ?? ""}${ssrScript}${docScript}`,
		)
		.replace("<!--app-html-->", rendered.html ?? "");
	const status = docData?.status === "missing" ? 404 : 200;
	return c.html(html, status);
});

export default app;
