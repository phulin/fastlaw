import type { Context } from "hono";
import { Hono } from "hono";
import type { PageData } from "./App";
import { render } from "./entry-server";
import {
	abortIngestJob,
	getAncestorNodes,
	getChildNodes,
	getIngestJobById,
	getLatestSourceVersion,
	getNodeByPath,
	getNodeContent,
	getSiblingNodes,
	getSourceByCode,
	getSourceVersionById,
	listIngestJobs,
	listIngestJobUnits,
	listSourceVersions,
	setEnv,
} from "./lib/db";
import {
	isDocumentRoute,
	isKnownPageRoute,
	parseStatuteRoute,
} from "./lib/routes";
import type { Env } from "./lib/types";
import { handleQuickSearch, handleSearch } from "./server/search";

type AppContext = {
	Bindings: Env & { ASSETS?: Fetcher };
};

const app = new Hono<AppContext>();

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
app.get("/api/ingest/jobs", async (c) => {
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const jobs = await listIngestJobs(limit);
	return c.json({ jobs });
});
app.get("/api/ingest/jobs/:jobId", async (c) => {
	const job = await getIngestJobById(c.req.param("jobId"));
	if (!job) {
		return c.json({ error: "Job not found" }, 404);
	}
	return c.json({ job });
});
app.get("/api/ingest/jobs/:jobId/units", async (c) => {
	const units = await listIngestJobUnits(c.req.param("jobId"));
	return c.json({ units });
});
app.get("/api/sources/:sourceId/versions", async (c) => {
	const source = await getSourceByCode(c.req.param("sourceId"));
	if (!source) {
		return c.json({ error: "Source not found" }, 404);
	}

	const versions = await listSourceVersions(source.id);
	return c.json({ versions });
});
app.post("/api/ingest/jobs/:jobId/abort", async (c) => {
	try {
		const job = await abortIngestJob(c.req.param("jobId"));
		return c.json({ ok: true, job });
	} catch (error) {
		if (error instanceof Error && error.message === "Job not found") {
			return c.json({ error: error.message }, 404);
		}
		if (error instanceof Error) {
			return c.json({ error: error.message }, 409);
		}
		return c.json({ error: "Abort failed" }, 500);
	}
});
app.post("/api/statutes/section-bodies", async (c) => {
	const payload = await c.req
		.json<{
			paths?: unknown;
			sourceVersionId?: unknown;
		}>()
		.catch(() => null);
	if (
		!payload ||
		!Array.isArray(payload.paths) ||
		payload.paths.some((path) => typeof path !== "string") ||
		(payload.sourceVersionId != null &&
			typeof payload.sourceVersionId !== "string")
	) {
		return c.json(
			{
				error:
					"Invalid payload. Expected { paths: string[]; sourceVersionId?: string }",
			},
			400,
		);
	}

	const paths = payload.paths as string[];
	const sourceVersionIdParam =
		typeof payload.sourceVersionId === "string" &&
		payload.sourceVersionId.trim().length > 0
			? payload.sourceVersionId.trim()
			: null;
	const uniquePaths = [...new Set(paths)];

	const uniqueResults = await Promise.all(
		uniquePaths.map(async (path) => {
			try {
				const route = parseStatuteRoute(path);
				if (!route) {
					return {
						path,
						status: "error" as const,
						error: "Path must start with /statutes/",
					};
				}

				const source = await getSourceByCode(route.sourceCode);
				if (!source) return { path, status: "not_found" as const };
				const sourceVersion = route.sourceVersionId
					? await getSourceVersionById(route.sourceVersionId)
					: sourceVersionIdParam
						? await getSourceVersionById(sourceVersionIdParam)
						: await getLatestSourceVersion(source.id);
				if (!sourceVersion) return { path, status: "not_found" as const };
				if (sourceVersion.source_id !== source.id) {
					return { path, status: "not_found" as const };
				}
				const node = await getNodeByPath(sourceVersion.id, route.nodePath);
				if (!node) return { path, status: "not_found" as const };
				const content = await getNodeContent(node);
				if (!content) return { path, status: "not_found" as const };
				return {
					path,
					status: "ok" as const,
					content,
				};
			} catch (error) {
				return {
					path,
					status: "error" as const,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);

	const resultByPath = new Map(
		uniqueResults.map((result) => [result.path, result]),
	);
	const orderedResults = paths
		.map((path) => resultByPath.get(path))
		.filter((result): result is NonNullable<typeof result> => result != null);

	return c.json({ results: orderedResults });
});

app.get("/pdf", async (c) => {
	const assets = c.env.ASSETS;
	if (!assets) return c.text("Assets not available", 500);

	// Fetch the template
	const url = new URL(c.req.url);
	url.pathname = "/pdf.html";
	const templateResponse = await assets.fetch(url.toString());

	if (!templateResponse.ok || !templateResponse.body) {
		return c.text("PDF viewer template not found", 404);
	}
	const template = await templateResponse.text();

	// SSR
	const { render } = await import("./entry-server-pdf");
	const rendered = render();
	const ssrScript = "<script>window.__SSR__=true</script>";

	const html = template
		.replace("<!--app-head-->", `${rendered.head ?? ""}${ssrScript}`)
		.replace("<!--app-html-->", rendered.html ?? "");

	return c.html(html, 200);
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

	let pageData: PageData | null = null;

	if (isDocumentRoute(url.pathname)) {
		const path = url.pathname;
		const route = parseStatuteRoute(path);

		// Get source and version
		const source = route ? await getSourceByCode(route.sourceCode) : null;
		if (!source) {
			pageData = { status: "missing", path };
		} else {
			const sourceVersion = route?.sourceVersionId
				? await getSourceVersionById(route.sourceVersionId)
				: await getLatestSourceVersion(source.id);
			if (!sourceVersion) {
				pageData = { status: "missing", path };
			} else if (sourceVersion.source_id !== source.id) {
				pageData = { status: "missing", path };
			} else {
				const nodePath = route?.nodePath ?? "/";
				if (path.endsWith(".json")) {
					const basePath = nodePath.slice(0, nodePath.length - 5);

					const node = await getNodeByPath(sourceVersion.id, basePath);
					if (!node) {
						return c.json({ status: "missing", path }, 404);
					}

					const content = await getNodeContent(node);
					if (!content) {
						return c.json({ status: "missing", path }, 404);
					}

					return c.json(content);
				}

				const node = await getNodeByPath(sourceVersion.id, nodePath);
				if (!node) {
					pageData = { status: "missing", path };
				} else {
					// Fetch both content and children
					const [content, children, ancestors] = await Promise.all([
						getNodeContent(node),
						getChildNodes(node.id),
						getAncestorNodes(node.id),
					]);
					const [nav, siblings] = await Promise.all([
						node.parent_id != null
							? getSiblingNodes(node.parent_id, node.sort_order)
							: undefined,
						node.parent_id != null ? getChildNodes(node.parent_id) : undefined,
					]);
					pageData = {
						status: "found",
						path,
						statuteRoutePrefix: route?.routePrefix ?? `/statutes/${source.id}`,
						node,
						source,
						sourceVersion,
						ancestors,
						content: content ?? undefined,
						nav,
						children: children.length > 0 ? children : undefined,
						siblings: siblings && siblings.length > 0 ? siblings : undefined,
					};
				}
			}
		}
	}

	const rendered = render(url.pathname, pageData);
	const ssrScript = "<script>window.__SSR__=true</script>";
	const pageScript = pageData
		? `<script>window.__PAGE_DATA__=${JSON.stringify(pageData)}</script>`
		: "";
	const html = template
		.replace(
			"<!--app-head-->",
			`${rendered.head ?? ""}${ssrScript}${pageScript}`,
		)
		.replace("<!--app-html-->", rendered.html ?? "");
	const status =
		pageData?.status === "missing" || !isKnownPageRoute(url.pathname)
			? 404
			: 200;
	return c.html(html, status);
});

export default app;
