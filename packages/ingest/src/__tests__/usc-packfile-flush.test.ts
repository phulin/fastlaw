import { describe, expect, it } from "vitest";
import { PackfileWriter } from "../lib/packfile/writer";

describe("USC packfile flush behavior", () => {
	it("does not produce uploadable packfiles until finalize() is called", async () => {
		const writer = new PackfileWriter("usc");

		await writer.addBlob(
			new TextEncoder().encode(
				JSON.stringify({
					blocks: [{ type: "body", content: "Section content" }],
				}),
			),
		);

		// This matches current callback behavior that only appends blobs.
		expect(writer.drainFinishedPackfiles()).toHaveLength(0);

		await writer.finalize();
		const finalized = writer.drainFinishedPackfiles();
		expect(finalized).toHaveLength(1);
		expect(finalized[0]?.entries).toHaveLength(1);
	});
});
