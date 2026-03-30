import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHandcraftedInstructionParserFromSource } from "../lib/redline/amendment-parser/handcrafted-instruction-parser";

interface BenchmarkConfig {
	filePath: string;
	grammarPath: string;
	warmupRuns: number;
	runs: number;
}

function parseArgs(argv: readonly string[]): BenchmarkConfig {
	const args = [...argv];
	const filePath =
		args[0] ?? resolve(process.cwd(), "tmp/bills-119hr1eas-paragraphs.txt");
	const grammarPath =
		args[1] ?? resolve(process.cwd(), "amendment-grammar.bnf");
	const warmupRuns = Number(args[2] ?? "0");
	const runs = Number(args[3] ?? "1");
	return { filePath, grammarPath, warmupRuns, runs };
}

function buildLineStartOffsets(lines: readonly string[]): number[] {
	const offsets: number[] = new Array(lines.length);
	let offset = 0;
	for (let i = 0; i < lines.length; i += 1) {
		offsets[i] = offset;
		offset += lines[i].length + 1;
	}
	return offsets;
}

function countNewlines(value: string): number {
	let count = 0;
	for (let i = 0; i < value.length; i += 1) {
		if (value[i] === "\n") count += 1;
	}
	return count;
}

function runParserDiscovery(
	source: string,
	lineStartOffsets: readonly number[],
	parser: ReturnType<typeof createHandcraftedInstructionParserFromSource>,
): number {
	let spanCount = 0;
	let lineIndex = 0;
	while (lineIndex < lineStartOffsets.length) {
		const startOffset = lineStartOffsets[lineIndex];
		const parsed = parser.parseInstructionFromSource(
			source,
			startOffset,
			undefined,
			{
				allowAnchoredOffsets: false,
			},
		);
		if (!parsed || parsed.parseOffset !== 0) {
			lineIndex += 1;
			continue;
		}
		spanCount += 1;
		lineIndex += countNewlines(parsed.text) + 1;
	}
	return spanCount;
}

function percentile(sortedSamples: readonly number[], p: number): number {
	if (sortedSamples.length === 0) return 0;
	const index = Math.min(
		sortedSamples.length - 1,
		Math.max(0, Math.floor((p / 100) * sortedSamples.length)),
	);
	return sortedSamples[index] ?? 0;
}

function formatMs(value: number): string {
	return `${value.toFixed(2)} ms`;
}

function main(): void {
	const config = parseArgs(process.argv.slice(2));
	const fileContents = readFileSync(config.filePath, "utf8");
	const grammarSource = readFileSync(config.grammarPath, "utf8");
	const parser = createHandcraftedInstructionParserFromSource(grammarSource);
	const lines = fileContents.split(/\r?\n/);
	const source = lines.join("\n");
	const lineStartOffsets = buildLineStartOffsets(lines);

	let lastSpanCount = 0;
	for (let i = 0; i < config.warmupRuns; i += 1) {
		lastSpanCount = runParserDiscovery(source, lineStartOffsets, parser);
	}

	const durationsMs: number[] = [];
	for (let i = 0; i < config.runs; i += 1) {
		const start = performance.now();
		lastSpanCount = runParserDiscovery(source, lineStartOffsets, parser);
		durationsMs.push(performance.now() - start);
	}

	const sortedDurations = [...durationsMs].sort((a, b) => a - b);
	const totalMs = durationsMs.reduce((sum, value) => sum + value, 0);
	const avgMs = totalMs / durationsMs.length;
	const minMs = sortedDurations[0] ?? 0;
	const maxMs = sortedDurations[sortedDurations.length - 1] ?? 0;
	const p50 = percentile(sortedDurations, 50);
	const p95 = percentile(sortedDurations, 95);
	const throughput = avgMs > 0 ? (lines.length * 1000) / avgMs : 0;

	console.log("Handcrafted Instruction Parser Benchmark");
	console.log(`file: ${config.filePath}`);
	console.log(`grammar: ${config.grammarPath}`);
	console.log(`lines: ${lines.length}`);
	console.log(`warmup runs: ${config.warmupRuns}`);
	console.log(`measured runs: ${config.runs}`);
	console.log(`spans found: ${lastSpanCount}`);
	console.log(`min: ${formatMs(minMs)}`);
	console.log(`p50: ${formatMs(p50)}`);
	console.log(`p95: ${formatMs(p95)}`);
	console.log(`avg: ${formatMs(avgMs)}`);
	console.log(`max: ${formatMs(maxMs)}`);
	console.log(`throughput: ${throughput.toFixed(2)} lines/sec`);
}

main();
