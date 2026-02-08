import { MetaProvider } from "@solidjs/meta";
import { Show } from "solid-js";
import type { PageData as PageDataType } from "~/lib/types";
import DeepSearchPage from "~/pages/DeepSearch";
import Home from "~/pages/Home";
import IngestJobPage from "~/pages/IngestJob";
import IngestJobsPage from "~/pages/IngestJobs";
import { NodePage } from "~/pages/Node";
import SearchPage from "~/pages/Search";

export type PageData = PageDataType;

interface AppProps {
	pathname: string;
	pageData: PageData | null;
}

const isDocumentRoute = (path: string) =>
	path === "/statutes" ||
	path.startsWith("/statutes/") ||
	path === "/cases" ||
	path.startsWith("/cases/");

const JOB_DETAIL_RE = /^\/ingest\/jobs\/([^/]+)$/;

function parseJobId(pathname: string): string | null {
	const match = JOB_DETAIL_RE.exec(pathname);
	return match ? match[1] : null;
}

export default function App(props: AppProps) {
	return (
		<MetaProvider>
			<Show when={props.pathname === "/"} fallback={null}>
				<Home />
			</Show>
			<Show when={props.pathname === "/search"} fallback={null}>
				<SearchPage />
			</Show>
			<Show when={props.pathname === "/deepsearch"} fallback={null}>
				<DeepSearchPage />
			</Show>
			<Show when={props.pathname === "/ingest/jobs"} fallback={null}>
				<IngestJobsPage />
			</Show>
			<Show when={parseJobId(props.pathname)} fallback={null}>
				{(jobId) => <IngestJobPage jobId={jobId()} />}
			</Show>
			<Show when={isDocumentRoute(props.pathname)} fallback={null}>
				<Show when={props.pageData?.status === "found"}>
					<NodePage
						data={props.pageData as Extract<PageData, { status: "found" }>}
					/>
				</Show>
			</Show>
		</MetaProvider>
	);
}
