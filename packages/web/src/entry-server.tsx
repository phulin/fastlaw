import { generateHydrationScript, renderToString } from "solid-js/web";
import type { PageData } from "./App";
import App from "./App";

export function render(pathname: string, pageData?: PageData | null) {
	const html = renderToString(() => (
		<App pathname={pathname} pageData={pageData ?? null} />
	));
	const head = generateHydrationScript();
	return { html, head };
}
