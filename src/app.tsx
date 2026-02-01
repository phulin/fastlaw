import { Show } from "solid-js";
import { DocumentStub } from "~/pages/DocumentStub";
import Home from "~/pages/Home";
import SearchPage from "~/pages/Search";
export type DocData = {
	status: "found" | "missing";
	slug: string;
};

interface AppProps {
	url?: string;
	docData?: DocData | null;
}

const getRoutePath = (url: string | undefined) => {
	if (!url) return "/";
	const path = url.split("?", 1)[0];
	return path || "/";
};

const isDocumentRoute = (path: string) =>
	path === "/statutes" ||
	path.startsWith("/statutes/") ||
	path === "/cases" ||
	path.startsWith("/cases/");

export default function App(props: AppProps) {
	const routePath = () => getRoutePath(props.url);

	return (
		<>
			<Show when={routePath() === "/"} fallback={null}>
				<Home />
			</Show>
			<Show when={routePath() === "/search"} fallback={null}>
				<SearchPage />
			</Show>
			<Show when={isDocumentRoute(routePath())} fallback={null}>
				<DocumentStub
					path={props.docData?.slug ?? routePath()}
					status={props.docData?.status}
				/>
			</Show>
			<Show
				when={
					routePath() !== "/" &&
					routePath() !== "/search" &&
					!isDocumentRoute(routePath())
				}
				fallback={null}
			>
				<DocumentStub path={routePath()} status="missing" />
			</Show>
		</>
	);
}
