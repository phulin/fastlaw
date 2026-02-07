const ALLOWED_HOST = "malegislature.gov";

function normalizeMglUrl(
	input: string,
	baseUrl: string,
	allowedPrefixes: readonly string[],
): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const lower = trimmed.toLowerCase();
	if (lower.startsWith("mailto:") || lower.startsWith("javascript:")) {
		return null;
	}

	const url = new URL(trimmed, baseUrl);
	if (url.hostname.toLowerCase() !== ALLOWED_HOST) return null;

	url.protocol = "https:";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
	if (!allowedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
		return null;
	}

	return url.toString();
}

export function normalizeMglPublicUrl(
	input: string,
	baseUrl: string,
): string | null {
	return normalizeMglUrl(input, baseUrl, ["/laws/generallaws"]);
}

export function normalizeMglApiUrl(
	input: string,
	baseUrl: string,
): string | null {
	return normalizeMglUrl(input, baseUrl, ["/api"]);
}
