import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, segment as rawSegment } from "sentencex-wasm";

let initialized = false;

function ensureInit() {
	if (initialized) return;
	// Load the wasm file synchronously
	const __dirname = dirname(fileURLToPath(import.meta.url));
	// src/lib/sentencex.ts points up to packages/web, then up to root node_modules
	const wasmPath = resolve(
		__dirname,
		"../../../../node_modules/sentencex-wasm/sentencex_wasm_bg.wasm",
	);
	const wasmBuffer = readFileSync(wasmPath);
	initSync({ module: wasmBuffer });
	initialized = true;
}

export function segment(language: string, text: string): string[] {
	ensureInit();
	return rawSegment(language, text);
}
