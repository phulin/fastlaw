import { Show } from "solid-js";
import type {
	DocumentContent,
	DocumentRecord,
	LevelPageData,
	LevelRecord,
} from "~/lib/types";
import DeepSearchPage from "~/pages/DeepSearch";
import { DocumentPage } from "~/pages/Document";
import { DocumentStub } from "~/pages/DocumentStub";
import Home from "~/pages/Home";
import { LevelPage } from "~/pages/Level";
import SearchPage from "~/pages/Search";

export type DocData =
	| {
			status: "missing";
			slug: string;
	  }
	| {
			status: "found";
			slug: string;
			doc: DocumentRecord;
			content: DocumentContent;
			level: LevelRecord | null;
			nav: { prev: LevelRecord | null; next: LevelRecord | null } | null;
			ancestors: LevelRecord[] | null;
			source: import("~/lib/types").SourceRecord | null;
	  };

export type LevelData = LevelPageData;

interface AppProps {
	pathname: string;
	docData: DocData | null;
	levelData: LevelData | null;
}

const isDocumentRoute = (path: string) =>
	path === "/statutes" ||
	path.startsWith("/statutes/") ||
	path === "/cases" ||
	path.startsWith("/cases/");

const isLevelRoute = (path: string) =>
	/^\/statutes\/[^/]+\/(title|chapter|part|subchapter)\/[^/]+$/.test(path);

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
			<Show when={isLevelRoute(props.pathname)} fallback={null}>
				<Show
					when={props.levelData?.status === "found"}
					fallback={
						<DocumentStub
							path={props.levelData?.slug ?? props.pathname}
							status={props.levelData?.status ?? "missing"}
						/>
					}
				>
					<LevelPage
						data={props.levelData as Extract<LevelData, { status: "found" }>}
					/>
				</Show>
			</Show>
			<Show
				when={isDocumentRoute(props.pathname) && !isLevelRoute(props.pathname)}
				fallback={null}
			>
				<Show
					when={props.docData?.status === "found"}
					fallback={
						<DocumentStub
							path={props.docData?.slug ?? props.pathname}
							status={props.docData?.status ?? "missing"}
						/>
					}
				>
					<DocumentPage
						doc={props.docData as Extract<DocData, { status: "found" }>}
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
