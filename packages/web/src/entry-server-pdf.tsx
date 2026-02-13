import { generateHydrationScript, renderToString } from "solid-js/web";
import PdfApp from "./PdfApp";

export function render() {
	const html = renderToString(() => <PdfApp />);
	const head = generateHydrationScript();
	return { html, head };
}
