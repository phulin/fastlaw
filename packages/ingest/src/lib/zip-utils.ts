import { ZipReaderStream } from "@zip.js/zip.js";

/**
 * Extract XML from a ZIP file as streaming chunks of Uint8Array.
 */
export async function* streamXmlFromZip(
	buffer: ArrayBuffer,
): AsyncGenerator<Uint8Array, void, void> {
	const bytes = new Uint8Array(buffer);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	yield* streamXmlFromZipStream(stream);
}

/**
 * Stream XML from a ZIP byte stream using ZipReaderStream.
 */
export async function* streamXmlFromZipStream(
	zipStream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
	const entryStream = zipStream.pipeThrough(new ZipReaderStream<Uint8Array>());
	const reader = entryStream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.directory) continue;
			if (!value.filename.toLowerCase().endsWith(".xml")) continue;
			if (!value.readable) {
				throw new Error(`ZIP entry has no readable stream: ${value.filename}`);
			}
			yield* streamFromReadableStream(value.readable);
			return;
		}
		console.warn("ZIP parse failed: no XML entry found");
	} finally {
		reader.releaseLock();
	}
}

/**
 * Convert a ReadableStream to an async generator of Uint8Array chunks.
 */
async function* streamFromReadableStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}
