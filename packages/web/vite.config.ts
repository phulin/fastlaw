import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ command }) => {
	const isWorkerBuild = process.env.BUILD_MODE === "worker";
	const isDev = command === "serve";
	const shouldRunCloudflare = isWorkerBuild || isDev;

	const plugins = [solid({ ssr: true })];
	if (shouldRunCloudflare) {
		plugins.push(...cloudflare());
	}

	return {
		plugins,
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
			outDir: isWorkerBuild ? undefined : "dist/client",
			rollupOptions: {
				input: isWorkerBuild
					? undefined
					: {
							main: path.resolve(__dirname, "index.html"),
							pdf: path.resolve(__dirname, "pdf.html"),
						},
			},
		},
	};
});
