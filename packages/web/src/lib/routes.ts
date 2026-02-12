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
