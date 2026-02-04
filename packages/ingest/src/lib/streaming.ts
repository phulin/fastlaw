export async function* streamFromReadableStream(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
	const reader = stream.getReader();
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) {
			yield value;
		}
	}
}
