import { Container } from "@cloudflare/containers";

export class IngestContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "30m" as const;

	override onStart(): void {
		console.log("[IngestContainer] Container started");
	}

	override onStop(params: { exitCode: number; reason: string }): void {
		if (params.exitCode !== 0) {
			console.error(
				`[IngestContainer] Container stopped with exit code ${params.exitCode}: ${params.reason}`,
			);
		} else {
			console.log("[IngestContainer] Container stopped gracefully");
		}
	}

	override onError(error: unknown): void {
		console.error(`[IngestContainer] Container error: ${error}`);
	}
}
