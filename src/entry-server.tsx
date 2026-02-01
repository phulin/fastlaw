import { generateHydrationScript, renderToString } from "solid-js/web";
import type { DocData } from "./App";
import App from "./App";

export function render(pathname: string, docData?: DocData | null) {
	const html = renderToString(() => (
		<App pathname={pathname} docData={docData ?? null} />
	));
	const head = generateHydrationScript();
	return { html, head };
}
