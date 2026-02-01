/* @refresh reload */
import { hydrate, render } from "solid-js/web";
import App from "./App";

const app = document.getElementById("app");

if (!app) {
	throw new Error("Missing #app container for App.");
}

const docData = window.__DOC_DATA__;

const AppRoot = () => (
	<App pathname={window.location.pathname} docData={docData ?? null} />
);

if (window.__SSR__) {
	hydrate(AppRoot, app);
} else {
	render(AppRoot, app);
}
