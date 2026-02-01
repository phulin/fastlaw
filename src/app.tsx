import { Show } from "solid-js";
import { DocumentStub } from "~/pages/DocumentStub";
import Home from "~/pages/Home";
import SearchPage from "~/pages/Search";
export type DocData = {
	status: "found" | "missing";
	slug: string;
};

interface AppProps {
	pathname: string;
	docData: DocData | null;
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
			<Show when={isDocumentRoute(props.pathname)} fallback={null}>
				<DocumentStub
					path={props.docData?.slug ?? props.pathname}
					status={props.docData?.status}
				/>
			</Show>
			<Show
				when={
					props.pathname !== "/" &&
					props.pathname !== "/search" &&
					!isDocumentRoute(props.pathname)
				}
				fallback={null}
			>
				<DocumentStub path={props.pathname} status="missing" />
			</Show>
		</>
	);
}
