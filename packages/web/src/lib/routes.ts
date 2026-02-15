const JOB_DETAIL_RE = /^\/ingest\/jobs\/([^/]+)$/;

export const isDocumentRoute = (pathname: string): boolean =>
	pathname === "/statutes" ||
	pathname.startsWith("/statutes/") ||
	pathname === "/cases" ||
	pathname.startsWith("/cases/");

export const parseIngestJobId = (pathname: string): string | null => {
	const match = JOB_DETAIL_RE.exec(pathname);
	return match ? match[1] : null;
};

export const isKnownPageRoute = (pathname: string): boolean =>
	pathname === "/" ||
	pathname === "/search" ||
	pathname === "/deepsearch" ||
	pathname === "/ingest/jobs" ||
	parseIngestJobId(pathname) !== null ||
	isDocumentRoute(pathname);

export interface StatuteRoute {
	sourceCode: string;
	sourceVersionId: string | null;
	sourceSegment: string;
	routePrefix: string;
	nodePath: string;
}

export const parseStatuteRoute = (pathname: string): StatuteRoute | null => {
	const parts = pathname.replace(/^\/+/, "").split("/");
	if (parts[0] !== "statutes") return null;

	const sourceSegment = parts[1];
	if (!sourceSegment) return null;

	const atIndex = sourceSegment.indexOf("@");
	const sourceCode =
		atIndex === -1 ? sourceSegment : sourceSegment.slice(0, atIndex);
	const sourceVersionId =
		atIndex === -1 ? null : sourceSegment.slice(atIndex + 1);
	if (!sourceCode) return null;

	const suffix = parts.slice(2).join("/");
	return {
		sourceCode,
		sourceVersionId:
			sourceVersionId && sourceVersionId.length > 0 ? sourceVersionId : null,
		sourceSegment,
		routePrefix: `/statutes/${sourceSegment}`,
		nodePath: suffix.length > 0 ? `/${suffix}` : "/",
	};
};

export const toStatuteRoutePath = (
	routePrefix: string,
	nodePath: string | null | undefined,
): string | null => {
	if (!nodePath) return null;
	if (nodePath === "/") return routePrefix;
	return `${routePrefix}${nodePath}`;
};
