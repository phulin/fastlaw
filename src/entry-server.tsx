import { generateHydrationScript, renderToString } from "solid-js/web";
import type { DocData, LevelData } from "./App";
import App from "./App";

export function render(
	pathname: string,
	docData?: DocData | null,
	levelData?: LevelData | null,
) {
	const html = renderToString(() => (
		<App
			pathname={pathname}
			docData={docData ?? null}
			levelData={levelData ?? null}
		/>
	));
	const head = generateHydrationScript();
	return { html, head };
}
