import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";

interface DocumentStubProps {
	path: string;
	status?: "found" | "missing";
}

export function DocumentStub(props: DocumentStubProps) {
	const displayPath = () => (props.path ? props.path : "/");
	const statusLabel = () =>
		props.status === "missing" ? "Document not found" : "Document stub";
	const statusCopy = () =>
		props.status === "missing"
			? "We could not locate a document record for this path."
			: "Document rendering is not wired yet. The requested path is shown below.";

	return (
		<>
			<Header />
			<main class="section-page">
				<section class="section-heading">
					<p class="eyebrow">{statusLabel()}</p>
					<h1>{statusLabel()}</h1>
					<p class="lead">{statusCopy()}</p>
				</section>
				<section class="section-block">
					<div class="section-title">
						<h2>Requested path</h2>
					</div>
					<div class="statute-meta">
						<p class="muted">{displayPath()}</p>
					</div>
					<a class="button ghost" href="/">
						Back to home
					</a>
				</section>
			</main>
			<Footer />
		</>
	);
}
