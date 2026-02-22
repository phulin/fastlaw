import { initSync, segment as rawSegment } from "sentencex-wasm";
import wasmUrl from "sentencex-wasm/sentencex_wasm_bg.wasm?url";

export async function initSentencex() {
	if (
		typeof process !== "undefined" &&
		process.versions &&
		process.versions.node
	) {
		// Webpack/Vite tries to bundle dynamic imports if it can resolve them statically.
		// Using a string interpolation trick usually hides it, but in node environments
		// like vitest we can just require or import directly.
		try {
			const fs = await import("node:fs");
			const url = await import("node:url");
			const path = await import("node:path");

			const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
			const wasmPath = path.resolve(
				__dirname,
				"../../../../node_modules/sentencex-wasm/sentencex_wasm_bg.wasm",
			);
			const wasmBuffer = fs.readFileSync(wasmPath);
			initSync({ module: wasmBuffer });
		} catch (e) {
			console.warn(
				"Failed node-based WASM initialization, falling back to fetch",
				e,
			);
			const response = await fetch(wasmUrl);
			const wasmArrayBuffer = await response.arrayBuffer();
			initSync({ module: wasmArrayBuffer });
		}
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
