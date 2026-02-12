import { Title } from "@solidjs/meta";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";
import type { IngestJobRecord, IngestJobUnitRecord } from "~/lib/types";

interface JobResponse {
	job: IngestJobRecord;
}

interface UnitsResponse {
	units: IngestJobUnitRecord[];
}

function formatDate(value: string | null): string {
	if (!value) return "—";
	return new Date(value).toLocaleString();
}

function nodeProgressLabel(total: number, processed: number): string {
	if (total === 0) return "—";
	return `${processed} / ${total}`;
}

function progressPercent(total: number, processed: number): number {
	if (total === 0) return 0;
	return Math.min(100, Math.round((processed / total) * 100));
}

export default function IngestJobPage(props: { jobId: string }) {
	const [job, setJob] = createSignal<IngestJobRecord | null>(null);
	const [units, setUnits] = createSignal<IngestJobUnitRecord[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const [aborting, setAborting] = createSignal(false);

	const isAbortable = (jobStatus: IngestJobRecord["status"]): boolean =>
		jobStatus === "planning" || jobStatus === "running";

	const refresh = async () => {
		try {
			const [jobRes, unitsRes] = await Promise.all([
				fetch(`/api/ingest/jobs/${props.jobId}`),
				fetch(`/api/ingest/jobs/${props.jobId}/units`),
			]);
			if (!jobRes.ok) throw new Error(`HTTP ${jobRes.status}`);
			const jobPayload = (await jobRes.json()) as JobResponse;
			setJob(jobPayload.job);

			if (unitsRes.ok) {
				const unitsPayload = (await unitsRes.json()) as UnitsResponse;
				setUnits(unitsPayload.units);
			}
			setError(null);
		} catch (refreshError) {
			setError(
				refreshError instanceof Error
					? refreshError.message
					: String(refreshError),
			);
		} finally {
			setLoading(false);
		}
	};

	const abortJob = async () => {
		if (!job()) return;
		setAborting(true);
		try {
			const response = await fetch(`/api/ingest/jobs/${props.jobId}/abort`, {
				method: "POST",
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			await refresh();
		} catch (abortError) {
			setError(
				abortError instanceof Error ? abortError.message : String(abortError),
			);
		} finally {
			setAborting(false);
		}
	};

	onMount(() => {
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, 5000);
		onCleanup(() => clearInterval(timer));
	});

	return (
		<>
			<Title>Job {props.jobId.slice(0, 8)} - Ingest - fast.law</Title>
			<Header />
			<main class="ingest-jobs-page">
				<section class="section-heading">
					<p class="eyebrow">
						<a href="/ingest/jobs">Ingest Jobs</a>
					</p>
					<h1>Job {props.jobId.slice(0, 8)}…</h1>
					<Show when={job()}>
						{(j) => (
							<button
								type="button"
								class="job-abort-button"
								onClick={() => void abortJob()}
								disabled={!isAbortable(j().status) || aborting()}
							>
								{aborting() ? "Aborting..." : "Abort job"}
							</button>
						)}
					</Show>
				</section>

				<Show when={loading()}>
					<p class="muted">Loading…</p>
				</Show>
				<Show when={error()}>
					<p class="ingest-error">Failed to load job: {error()}</p>
				</Show>

				<Show when={job()}>
					{(j) => (
						<>
							<div class="job-detail-meta">
								<dl class="job-detail-grid">
									<dt>Status</dt>
									<dd>
										<span class={`status-pill ${j().status}`}>
											{j().status.replace(/_/g, " ")}
										</span>
									</dd>
									<dt>Source</dt>
									<dd>{j().source_code.toUpperCase()}</dd>
									<dt>Version</dt>
									<dd>{j().source_version_id ?? "—"}</dd>
									<dt>Titles</dt>
									<dd>
										{j().processed_titles} / {j().total_titles}
									</dd>
									<dt>Nodes</dt>
									<dd>
										{nodeProgressLabel(j().total_nodes, j().processed_nodes)}
									</dd>
									<dt>Errors</dt>
									<dd>{j().error_count}</dd>
									<dt>Started</dt>
									<dd>{formatDate(j().started_at)}</dd>
									<dt>Completed</dt>
									<dd>{formatDate(j().completed_at)}</dd>
								</dl>
							</div>

							<Show when={units().length > 0}>
								<h2 class="job-units-heading">Units</h2>
								<div class="jobs-table-wrap">
									<table class="jobs-table">
										<thead>
											<tr>
												<th>Unit</th>
												<th>Status</th>
												<th>Nodes</th>
												<th>Progress</th>
												<th>Started</th>
												<th>Completed</th>
											</tr>
										</thead>
										<tbody>
											<For each={units()}>
												{(unit) => (
													<tr>
														<td class="jobs-id">{unit.unit_id}</td>
														<td>
															<span class={`status-pill ${unit.status}`}>
																{unit.status}
															</span>
														</td>
														<td>
															{nodeProgressLabel(
																unit.total_nodes,
																unit.processed_nodes,
															)}
														</td>
														<td>
															<div class="progress-bar-wrap">
																<div
																	class="progress-bar-fill"
																	style={{
																		width: `${progressPercent(unit.total_nodes, unit.processed_nodes)}%`,
																	}}
																/>
															</div>
														</td>
														<td>{formatDate(unit.started_at)}</td>
														<td>{formatDate(unit.completed_at)}</td>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</div>
							</Show>
						</>
					)}
				</Show>
			</main>
			<Footer />
		</>
	);
}
