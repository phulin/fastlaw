import { initSync, segment as rawSegment } from "sentencex-wasm";
import wasmUrl from "sentencex-wasm/sentencex_wasm_bg.wasm?url";

export async function initSentencex() {
	if (
		typeof process !== "undefined" &&
		process.versions &&
		process.versions.node
	) {
		// Use a dynamic import via new Function to completely hide it from Vite/Rollup
		const dynamicImport = new Function(
			"modulePath",
			"return import(modulePath)",
		);

		const { readFileSync } = await dynamicImport("node:fs");
		const { fileURLToPath } = await dynamicImport("node:url");
		const { dirname, resolve } = await dynamicImport("node:path");

		const __dirname = dirname(fileURLToPath(import.meta.url));
		const wasmPath = resolve(
			__dirname,
			"../../../../node_modules/sentencex-wasm/sentencex_wasm_bg.wasm",
		);
		const wasmBuffer = readFileSync(wasmPath);
		initSync({ module: wasmBuffer });
	} else {
		// Ensure this is properly fetched in the browser
		const response = await fetch(wasmUrl);
		const wasmArrayBuffer = await response.arrayBuffer();
		initSync({ module: wasmArrayBuffer });
	}
}

// Ensure it's initialized before usage
await initSentencex();

export function segment(language: string, text: string): string[] {
	return rawSegment(language, text);
}
