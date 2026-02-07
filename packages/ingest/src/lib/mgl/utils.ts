const ALLOWED_HOST = "malegislature.gov";
const ALLOWED_PREFIX = "/laws/generallaws";

export function normalizeMglUrl(input: string, baseUrl: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("mailto:") || lower.startsWith("javascript:")) {
		return null;
	}

	const url = new URL(trimmed, baseUrl);
	if (url.hostname.toLowerCase() !== ALLOWED_HOST) return null;

	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
	if (!url.pathname.startsWith(ALLOWED_PREFIX)) return null;

	return url.toString();
}
