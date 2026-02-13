import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
	plugins: [cloudflare(), solid({ ssr: true })],
	resolve: {
		alias: {
			"~": path.resolve(__dirname, "src"),
		},
	},
	ssr: {
		target: "webworker",
		noExternal: ["solid-js", "solid-js/web"],
	},
	build: {
		rollupOptions: {
			input: {
				main: path.resolve(__dirname, "index.html"),
				pdf: path.resolve(__dirname, "pdf.html"),
			},
		},
	},
});
