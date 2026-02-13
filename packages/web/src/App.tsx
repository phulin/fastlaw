import { MetaProvider } from "@solidjs/meta";
import { Match, Switch } from "solid-js";
import { isDocumentRoute, parseIngestJobId } from "~/lib/routes";
import type { PageData as PageDataType } from "~/lib/types";
import DeepSearchPage from "~/pages/DeepSearch";
import IngestJobPage from "~/pages/IngestJob";
import IngestJobsPage from "~/pages/IngestJobs";
import { NodePage } from "~/pages/Node";
import NotFoundPage from "~/pages/NotFound";
import SearchPage from "~/pages/Search";


export type PageData = PageDataType;

interface AppProps {
	pathname: string;
	pageData: PageData | null;
}

export default function App(props: AppProps) {
	const jobId = parseIngestJobId(props.pathname);
	const isFoundDocument =
		isDocumentRoute(props.pathname) && props.pageData?.status === "found";

	return (
		<MetaProvider>
			<Switch fallback={<NotFoundPage pathname={props.pathname} />}>
				<Match when={props.pathname === "/"}>
					<SearchPage />
				</Match>
				<Match when={props.pathname === "/search"}>
					<SearchPage />
				</Match>
				<Match when={props.pathname === "/deepsearch"}>
					<DeepSearchPage />
				</Match>
				<Match when={props.pathname === "/ingest/jobs"}>
					<IngestJobsPage />
				</Match>
				<Match when={jobId}>
					{(resolvedJobId) => <IngestJobPage jobId={resolvedJobId()} />}
				</Match>

				<Match when={isFoundDocument}>
					<NodePage
						data={props.pageData as Extract<PageData, { status: "found" }>}
					/>
				</Match>
			</Switch>
		</MetaProvider>
	);
}
