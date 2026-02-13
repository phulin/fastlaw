/* @refresh reload */
import { hydrate, render } from "solid-js/web";
import PdfApp from "./PdfApp";

const app = document.getElementById("app");

if (!app) {
	throw new Error("Missing #app container for App.");
}

if (window.__SSR__) {
	hydrate(() => <PdfApp />, app);
} else {
	render(() => <PdfApp />, app);
}
