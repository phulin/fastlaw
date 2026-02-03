/* @refresh reload */
import { hydrate, render } from "solid-js/web";
import App from "./App";

const app = document.getElementById("app");

if (!app) {
	throw new Error("Missing #app container for App.");
}

const pageData = window.__PAGE_DATA__;

const AppRoot = () => (
	<App pathname={window.location.pathname} pageData={pageData ?? null} />
);

if (window.__SSR__) {
	hydrate(AppRoot, app);
} else {
	render(AppRoot, app);
}
