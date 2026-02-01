import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./styles/global.css";

export default function App() {
	return (
		<Router
			root={(props) => (
				<Suspense fallback={<div class="page">Loading...</div>}>
					{props.children}
				</Suspense>
			)}
		>
			<FileRoutes />
		</Router>
	);
}
