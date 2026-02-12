import { Container } from "@cloudflare/containers";

const RUNNING_JOBS_KEY = "runningJobs";

export class IngestContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "30m" as const;
	private runningJobs = new Set<string>();
	private loadedRunningJobs = false;

	private async loadRunningJobs(): Promise<void> {
		if (this.loadedRunningJobs) return;
		const stored = await this.ctx.storage.get<string[]>(RUNNING_JOBS_KEY);
		this.runningJobs = new Set(stored ?? []);
		this.loadedRunningJobs = true;
	}

	private async persistRunningJobs(): Promise<void> {
		await this.ctx.storage.put(RUNNING_JOBS_KEY, [...this.runningJobs]);
	}

	async registerJob(jobId: string): Promise<{ runningJobs: string[] }> {
		await this.loadRunningJobs();
		this.runningJobs.add(jobId);
		await this.persistRunningJobs();
		return { runningJobs: [...this.runningJobs] };
	}

	async requestStopForJob(
		jobId: string,
	): Promise<{ stopped: boolean; runningJobs: string[] }> {
		await this.loadRunningJobs();
		this.runningJobs.delete(jobId);
		await this.persistRunningJobs();

		if (this.runningJobs.size > 0) {
			return { stopped: false, runningJobs: [...this.runningJobs] };
		}

		await this.stop();
		return { stopped: true, runningJobs: [] };
	}

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
