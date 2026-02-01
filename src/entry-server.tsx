import { generateHydrationScript, renderToString } from "solid-js/web";
import type { DocData } from "./App";
import App from "./App";

export function render(url: string, docData?: DocData | null) {
	const html = renderToString(() => (
		<App url={url} docData={docData ?? null} />
	));
	const head = generateHydrationScript();
	return { html, head };
}
