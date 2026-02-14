import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

function isTextItem(item: unknown): item is TextItem {
	if (typeof item !== "object" || item === null) return false;
	const candidate = item as {
		str?: unknown;
		transform?: unknown;
		width?: unknown;
		height?: unknown;
	};
	return (
		typeof candidate.str === "string" &&
		Array.isArray(candidate.transform) &&
		typeof candidate.width === "number" &&
		typeof candidate.height === "number"
	);
}

function isWhitespaceOnly(s: string): boolean {
	return s.trim().length === 0;
}

function isNumeric(s: string): boolean {
	return /^\d{1,4}$/.test(s.trim());
}

function median(nums: number[]): number {
	const arr = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(arr.length / 2);
	return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function isTopCenteredPageNumberSpan(
	item: TextItem,
	pageWidth: number,
	pageHeight: number,
): boolean {
	if (!isNumeric(item.str)) return false;
	const x = item.transform[4];
	const y = item.transform[5];
	const itemCenter = x + item.width / 2;
	const pageCenter = pageWidth / 2;
	const centerTolerance = pageWidth * 0.08;
	return (
		Math.abs(itemCenter - pageCenter) <= centerTolerance &&
		y >= pageHeight * 0.9
	);
}

interface SimpleLine {
	page: number;
	y: number;
	xStart: number;
	xEnd: number;
	text: string;
}

function detectLines(
	items: TextItem[],
	pageNumber: number,
	pageWidth: number,
	pageHeight: number,
): SimpleLine[] {
	const enriched = items
		.filter(
			(item) => !isTopCenteredPageNumberSpan(item, pageWidth, pageHeight),
		)
		.filter((item) => !isWhitespaceOnly(item.str))
		.map((item) => ({
			item,
			x: item.transform[4],
			y: item.transform[5],
			w: item.width,
			h: item.height || 10,
		}));

	if (enriched.length === 0) return [];

	const yTolerance = median(enriched.map((e) => e.h)) * 0.45;

	enriched.sort((a, b) =>
		Math.abs(b.y - a.y) > yTolerance ? b.y - a.y : a.x - b.x,
	);

	const lines: SimpleLine[] = [];
	let current: typeof enriched = [];

	for (const e of enriched) {
		if (!current.length) {
			current.push(e);
			continue;
		}

		const prev = current[current.length - 1];
		if (Math.abs(prev.y - e.y) < yTolerance) {
			current.push(e);
		} else {
			lines.push(buildLine(current, pageNumber));
			current = [e];
		}
	}

	if (current.length) {
		lines.push(buildLine(current, pageNumber));
	}

	return lines;
}

function buildLine(
	enriched: { item: TextItem; x: number; y: number; w: number; h: number }[],
	page: number,
): SimpleLine {
	enriched.sort((a, b) => a.x - b.x);

	let text = "";
	const lineHeight = median(enriched.map((e) => e.h));
	for (let i = 0; i < enriched.length; i++) {
		if (i > 0) {
			const gap = enriched[i].x - (enriched[i - 1].x + enriched[i - 1].w);
			if (gap > lineHeight * 0.24) text += " ";
		}
		text += enriched[i].item.str;
	}

	return {
		page,
		y: enriched[0].y,
		xStart: enriched[0].x,
		xEnd: enriched[enriched.length - 1].x + enriched[enriched.length - 1].w,
		text,
	};
}

async function main() {
	const fixtureUrl = new URL("../../hr1-abridged.pdf", import.meta.url);
	const data = new Uint8Array(await readFile(fixtureUrl));
	// @ts-expect-error - PDF.js runtime supports this option
	const loadingTask = getDocument({ data, disableWorker: true });
	const pdf = await loadingTask.promise;

	for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
		const page = await pdf.getPage(pageNum);
		const viewport = page.getViewport({ scale: 1 });
		const reader = page.streamTextContent().getReader();
		const items: TextItem[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value as { items?: unknown[] } | undefined;
			if (!chunk?.items) continue;
			items.push(...chunk.items.filter(isTextItem));
		}

		const lines = detectLines(items, pageNum, viewport.width, viewport.height);

		console.log(
			`\n=== Page ${pageNum} (${viewport.width}x${viewport.height}) ===`,
		);
		for (const line of lines) {
			console.log(
				`  y=${line.y.toFixed(1)} x=[${line.xStart.toFixed(1)},${line.xEnd.toFixed(1)}] "${line.text}"`,
			);
		}
	}

	await pdf.destroy();
}

main().catch(console.error);
