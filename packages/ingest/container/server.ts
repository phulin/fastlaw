import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { type IngestConfig, ingestUSC } from "./ingest-usc";

function readJson<T>(req: IncomingMessage): Promise<T> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

const server = createServer(
	async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "POST" && req.url === "/ingest") {
			let config: IngestConfig;
			try {
				config = await readJson<IngestConfig>(req);
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid request body" }));
				return;
			}

			// ACK immediately
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "accepted" }));

			// Process in background — the Node.js event loop stays alive
			// because the HTTP server is still listening.
			ingestUSC(config).catch((err) => {
				console.error("[Container] Ingest failed:", err);
			});
			return;
		}

		res.writeHead(200);
		res.end("ok");
	},
);

server.listen(8080, () => {
	console.log("[Container] Listening on :8080");
});
