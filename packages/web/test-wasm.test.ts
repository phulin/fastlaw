import initWasm, { segment } from "sentencex-wasm";

async function test() {
	try {
		await initWasm();
		console.log(segment("en", "Hello World. This is a test."));
	} catch (e: any) {
		console.error("Init failed:", e);
	}
}

test();
