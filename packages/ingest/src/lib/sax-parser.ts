import {
	type Attribute,
	SAXParser,
	SaxEventType,
	type Tag,
	type Text,
} from "sax-wasm";

const PARSER_EVENTS =
	SaxEventType.OpenTag |
	SaxEventType.CloseTag |
	SaxEventType.Text |
	SaxEventType.Attribute;

const SAX_WASM_CHUNK_SIZE = 256 * 1024;
const IS_TEST = typeof process !== "undefined" && process.env.VITEST === "true";

async function loadSaxWasm(): Promise<
	Uint8Array | WebAssembly.Module | Response
> {
	if (IS_TEST) {
		const { createRequire } = await import("node:module");
		const { readFile } = await import("node:fs/promises");
		const require = createRequire(import.meta.url);
		const wasmPath = require.resolve("sax-wasm/lib/sax-wasm.wasm");
		const buffer = await readFile(wasmPath);
		return new Uint8Array(buffer);
	}

	const { default: saxWasm } = await import("sax-wasm/lib/sax-wasm.wasm");
	return saxWasm;
}

/**
 * Create a fresh SAXParser instance with WASM initialized.
 * WASM bytes are cached but parser instances are created fresh each time
 * to avoid detached ArrayBuffer issues when reusing parsers.
 */
export async function getSAXParser(): Promise<SAXParser> {
	const parser = new SAXParser(PARSER_EVENTS);
	const saxWasm = await loadSaxWasm();
	await parser.prepareWasm(saxWasm);
	return parser;
}

/** Extracted attribute with string values (safe after WASM memory grows) */
export interface ExtractedAttribute {
	name: string;
	value: string;
}

/** Extracted tag with string values (safe after WASM memory grows) */
export interface ExtractedTag {
	name: string;
	attributes: ExtractedAttribute[];
	selfClosing: boolean;
}

/** Extracted text with string value (safe after WASM memory grows) */
export interface ExtractedText {
	value: string;
}

export type SaxEvent =
	| { type: "openTag"; tag: ExtractedTag }
	| { type: "closeTag"; tag: ExtractedTag }
	| { type: "text"; text: ExtractedText };

/**
 * Extract string values from Tag immediately to avoid detached ArrayBuffer issues.
 * WASM memory can grow during parsing, detaching buffers for earlier events.
 */
function extractTag(tag: Tag): ExtractedTag {
	return {
		name: tag.name,
		attributes: tag.attributes.map((attr: Attribute) => ({
			name: attr.name.value,
			value: attr.value.value,
		})),
		selfClosing: tag.selfClosing,
	};
}

/**
 * Extract string value from Text immediately to avoid detached ArrayBuffer issues.
 */
function extractText(text: Text): ExtractedText {
	return { value: text.value };
}

export type SaxEventHandler = (event: SaxEvent) => void;

/**
 * Parse XML using synchronous event handlers to avoid detached ArrayBuffer issues.
 * String values are extracted immediately when events fire, before WASM memory can grow.
 */
export async function parseXmlWithHandler(
	input: string | Uint8Array,
	handler: SaxEventHandler,
): Promise<void> {
	const parser = await getSAXParser();

	parser.eventHandler = (eventType, data) => {
		switch (eventType) {
			case SaxEventType.OpenTag:
				handler({ type: "openTag", tag: extractTag(data as Tag) });
				break;
			case SaxEventType.CloseTag:
				handler({ type: "closeTag", tag: extractTag(data as Tag) });
				break;
			case SaxEventType.Text:
				handler({ type: "text", text: extractText(data as Text) });
				break;
		}
	};

	const bytes =
		typeof input === "string" ? new TextEncoder().encode(input) : input;
	writeInChunks(parser, bytes);
	parser.end();
}

/**
 * Parse XML from streaming chunks using synchronous event handlers.
 * Processes chunks as they arrive, keeping memory usage bounded.
 */
export async function parseXmlStreamWithHandler(
	chunks: AsyncIterable<Uint8Array>,
	handler: SaxEventHandler,
): Promise<void> {
	const parser = await getSAXParser();

	parser.eventHandler = (eventType, data) => {
		switch (eventType) {
			case SaxEventType.OpenTag:
				handler({ type: "openTag", tag: extractTag(data as Tag) });
				break;
			case SaxEventType.CloseTag:
				handler({ type: "closeTag", tag: extractTag(data as Tag) });
				break;
			case SaxEventType.Text:
				handler({ type: "text", text: extractText(data as Text) });
				break;
		}
	};

	for await (const chunk of chunks) {
		writeInChunks(parser, chunk);
	}
	parser.end();
}

function writeInChunks(parser: SAXParser, chunk: Uint8Array): void {
	for (let offset = 0; offset < chunk.length; offset += SAX_WASM_CHUNK_SIZE) {
		parser.write(chunk.subarray(offset, offset + SAX_WASM_CHUNK_SIZE));
	}
}
