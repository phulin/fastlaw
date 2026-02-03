import { Show } from "solid-js";
import type { PageData as PageDataType } from "~/lib/types";
import DeepSearchPage from "~/pages/DeepSearch";
import { DocumentStub } from "~/pages/DocumentStub";
import Home from "~/pages/Home";
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

export default function App(props: AppProps) {
	return (
		<>
			<Show when={props.pathname === "/"} fallback={null}>
				<Home />
			</Show>
			<Show when={props.pathname === "/search"} fallback={null}>
				<SearchPage />
			</Show>
			<Show when={props.pathname === "/deepsearch"} fallback={null}>
				<DeepSearchPage />
			</Show>
			<Show when={isDocumentRoute(props.pathname)} fallback={null}>
				<Show
					when={props.pageData?.status === "found"}
					fallback={
						<DocumentStub
							path={props.pageData?.path ?? props.pathname}
							status={props.pageData?.status ?? "missing"}
						/>
					}
				>
					<NodePage
						data={props.pageData as Extract<PageData, { status: "found" }>}
					/>
				</Show>
			</Show>
			<Show
				when={
					props.pathname !== "/" &&
					props.pathname !== "/search" &&
					props.pathname !== "/deepsearch" &&
					!isDocumentRoute(props.pathname)
				}
				fallback={null}
			>
				<DocumentStub path={props.pathname} status="missing" />
			</Show>
		</>
	);
}
