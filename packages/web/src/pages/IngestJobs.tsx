import { Title } from "@solidjs/meta";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";
import type { IngestJobRecord } from "~/lib/types";

interface JobsResponse {
	jobs: IngestJobRecord[];
}

function formatDate(value: string | null): string {
	if (!value) {
		return "—";
	}
	return new Date(value).toLocaleString();
}

function titlesLabel(job: IngestJobRecord): string {
	if (job.total_titles === 0) return "0 / 0";
	return `${job.processed_titles} / ${job.total_titles}`;
}

function nodesLabel(job: IngestJobRecord): string {
	if (job.total_nodes === 0) return "—";
	return `${job.processed_nodes} / ${job.total_nodes}`;
}

export default function IngestJobsPage() {
	const [jobs, setJobs] = createSignal<IngestJobRecord[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const [lastRefreshedAt, setLastRefreshedAt] = createSignal<string | null>(
		null,
	);

	const refresh = async () => {
		try {
			const response = await fetch("/api/ingest/jobs?limit=200");
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const payload = (await response.json()) as JobsResponse;
			setJobs(payload.jobs);
			setLastRefreshedAt(new Date().toISOString());
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

	onMount(() => {
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, 5000);
		onCleanup(() => {
			clearInterval(timer);
		});
	});

	return (
		<>
			<Title>Ingest Jobs - fast.law</Title>
			<Header />
			<main class="ingest-jobs-page">
				<section class="section-heading">
					<p class="eyebrow">Operations</p>
					<h1>Ingest queue status</h1>
					<p class="ingest-jobs-meta">
						Auto-refresh every 5 seconds. Last refresh:{" "}
						{lastRefreshedAt() ? formatDate(lastRefreshedAt()) : "—"}
					</p>
				</section>

				<Show when={loading()}>
					<p class="muted">Loading jobs...</p>
				</Show>
				<Show when={error()}>
					<p class="ingest-error">Failed to load jobs: {error()}</p>
				</Show>
				<Show when={!loading() && jobs().length === 0}>
					<p class="muted">No ingest jobs yet.</p>
				</Show>

				<Show when={jobs().length > 0}>
					<div class="jobs-table-wrap">
						<table class="jobs-table">
							<thead>
								<tr>
									<th>Job ID</th>
									<th>Source</th>
									<th>Status</th>
									<th>Titles</th>
									<th>Nodes</th>
									<th>Errors</th>
									<th>Version</th>
									<th>Started</th>
									<th>Completed</th>
								</tr>
							</thead>
							<tbody>
								<For each={jobs()}>
									{(job) => (
										<tr>
											<td class="jobs-id">
												<a href={`/ingest/jobs/${job.id}`}>{job.id}</a>
											</td>
											<td>{job.source_code.toUpperCase()}</td>
											<td>
												<span class={`status-pill ${job.status}`}>
													{job.status.replace(/_/g, " ")}
												</span>
											</td>
											<td>{titlesLabel(job)}</td>
											<td>{nodesLabel(job)}</td>
											<td>{job.error_count}</td>
											<td>{job.source_version_id ?? "—"}</td>
											<td>{formatDate(job.started_at)}</td>
											<td>{formatDate(job.completed_at)}</td>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</div>
				</Show>
			</main>
			<Footer />
		</>
	);
}
