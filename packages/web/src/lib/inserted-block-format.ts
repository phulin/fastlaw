import { buildInferredMarkerLevels } from "./marker-level-inference";

interface FormatInsertedBlockOptions {
	baseDepth: number;
	quotePlainMultiline: boolean;
}

function quotePrefix(depth: number): string {
	if (depth <= 0) return "";
	return `${Array.from({ length: depth }, () => ">").join(" ")} `;
}

function splitHeadingFromBody(
	rest: string,
): { heading: string; body: string | null } | null {
	const match = rest.match(/^([A-Z0-9][A-Z0-9 '"()\-.,/&]+)\.\u2014\s*(.*)$/);
	if (!match) return null;
	const heading = match[1]?.trim();
	if (!heading) return null;
	const body = (match[2] ?? "").trim();
	return { heading, body: body.length > 0 ? body : null };
}

function sanitizeQuotedLine(line: string): string {
	return line
		.trim()
		.replace(/^[“”"'‘’]+/, "")
		.replace(/[“”"'‘’]+[.;,]*$/, "")
		.trim();
}

export function formatInsertedBlockContent(
	content: string,
	options: FormatInsertedBlockOptions,
): string {
	const rawLines = content.split("\n");
	const baseDepth = Math.max(0, options.baseDepth);
	const markerLines = rawLines
		.map((line) => sanitizeQuotedLine(line).match(/^\(([^)]+)\)\s*(.*)$/))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (markerLines.length === 0) {
		if (!content.includes("\n")) return content;
		if (!options.quotePlainMultiline) return content;
		return rawLines
			.map((rawLine) => {
				const cleaned = sanitizeQuotedLine(rawLine);
				if (cleaned.length === 0) return "";
				return `${quotePrefix(baseDepth)}${cleaned}`;
			})
			.join("\n");
	}

	const inferredMarkerRanks =
		buildInferredMarkerLevels([
			{
				markers: markerLines.map((markerLine) => markerLine[1] ?? ""),
				indentationHint: baseDepth,
			},
		])[0]?.map((level) => level.rank) ?? [];

	const minMarkerRank = Math.min(...inferredMarkerRanks);
	let activeDepth = baseDepth;
	let markerIndex = 0;
	const formattedLines: string[] = [];

	for (const rawLine of rawLines) {
		const cleaned = sanitizeQuotedLine(rawLine);
		if (cleaned.length === 0) {
			formattedLines.push("");
			continue;
		}

		const markerMatch = cleaned.match(/^\(([^)]+)\)\s*(.*)$/);
		if (!markerMatch) {
			formattedLines.push(`${quotePrefix(activeDepth)}${cleaned}`);
			continue;
		}

		const marker = markerMatch[1] ?? "";
		const rest = markerMatch[2] ?? "";
		const markerRank = inferredMarkerRanks[markerIndex] ?? minMarkerRank;
		markerIndex += 1;
		const markerDepth = baseDepth + (markerRank - minMarkerRank);
		activeDepth = markerDepth;

		const headingSplit = splitHeadingFromBody(rest);
		if (headingSplit) {
			formattedLines.push(
				`${quotePrefix(markerDepth)}**(${marker})** **${headingSplit.heading}**`,
			);
			if (headingSplit.body) {
				formattedLines.push(`${quotePrefix(markerDepth)}${headingSplit.body}`);
			}
			continue;
		}

		formattedLines.push(
			`${quotePrefix(markerDepth)}**(${marker})**${rest ? ` ${rest}` : ""}`,
		);
	}

	return formattedLines.join("\n");
}
