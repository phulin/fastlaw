import type { IngestJob, WorkerEnv } from "./types";

type ProgressStatus = IngestJob["status"];

interface ProgressUpdate {
	status: ProgressStatus;
	progress: number;
	message?: string;
	result?: unknown;
	error?: unknown;
}

interface ProgressEvent extends ProgressUpdate {
	id: number;
	ts: string;
}

export class ProgressDO {
	private state: DurableObjectState;
	private env: WorkerEnv;
	private events: ProgressEvent[] = [];
	private connections = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private lastEventId = 0;

	constructor(state: DurableObjectState, env: WorkerEnv) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname.endsWith("/progress")) {
			return this.handleProgress(request, url);
		}
		if (request.method === "GET" && url.pathname.endsWith("/events")) {
			return this.handleEvents();
		}
		return new Response("Not found", { status: 404 });
	}

	private async handleProgress(request: Request, url: URL): Promise<Response> {
		const update = (await request.json()) as ProgressUpdate;
		const event: ProgressEvent = {
			...update,
			id: ++this.lastEventId,
			ts: new Date().toISOString(),
		};

		this.events.push(event);
		if (this.events.length > 50) {
			this.events.shift();
		}

		const jobId = this.getJobId(url);
		await this.persistSnapshot(jobId, event);
		this.broadcast(event);

		return new Response(null, { status: 204 });
	}

	private handleEvents(): Response {
		let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
			null;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				controllerRef = controller;
				this.connections.add(controller);
				for (const event of this.events) {
					this.sendEvent(controller, "progress", event);
				}
			},
			cancel: () => {
				if (controllerRef) {
					this.connections.delete(controllerRef);
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	private sendEvent(
		controller: ReadableStreamDefaultController<Uint8Array>,
		event: string,
		data: unknown,
	) {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		controller.enqueue(new TextEncoder().encode(payload));
	}

	private broadcast(event: ProgressEvent) {
		for (const controller of this.connections) {
			this.sendEvent(controller, "progress", event);
		}
	}

	private async persistSnapshot(
		jobId: string,
		event: ProgressEvent,
	): Promise<void> {
		const finishedAt =
			event.status === "succeeded" || event.status === "failed"
				? event.ts
				: null;
		const resultJson =
			event.status === "succeeded" && event.result !== undefined
				? JSON.stringify(event.result)
				: null;
		const errorJson =
			event.status === "failed" && event.error !== undefined
				? JSON.stringify(event.error)
				: null;

		await this.env.DB.prepare(
			`UPDATE ingest_jobs
			 SET status = ?,
			     progress = ?,
			     message = ?,
			     updated_at = ?,
			     started_at = COALESCE(started_at, ?),
			     finished_at = COALESCE(?, finished_at),
			     result_json = COALESCE(?, result_json),
			     error_json = COALESCE(?, error_json)
			 WHERE id = ?`,
		)
			.bind(
				event.status,
				event.progress,
				event.message ?? null,
				event.ts,
				event.status === "running" ? event.ts : null,
				finishedAt,
				resultJson,
				errorJson,
				jobId,
			)
			.run();
	}

	private getJobId(url: URL): string {
		const parts = url.pathname.split("/");
		const index = parts.indexOf("jobs");
		return index >= 0 ? parts[index + 1] : this.state.id.toString();
	}
}
