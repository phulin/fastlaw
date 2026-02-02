import { createSignal, For, Show } from "solid-js";
import { Header } from "~/components/Header";

interface SearchResult {
	id: string;
	score: number;
	section_id: string | null;
	section_label: string | null;
	section_number: string | null;
	section_title: string | null;
	chapter_id: string | null;
	title_id: string | null;
	text: string | null;
}

const buildSectionHref = (sectionId: string | null): string | null => {
	if (!sectionId || typeof sectionId !== "string") return null;
	const rawId = sectionId.replace(/^secs?_/, "");
	const [title, suffix] = rawId.split("-", 2);
	if (!title || !suffix) return null;
	return `/statutes/cgs/section/${title}/${suffix}`;
};

export default function SearchPage() {
	const [query, setQuery] = createSignal("");
	const [results, setResults] = createSignal<SearchResult[]>([]);
	const [isLoading, setIsLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [lastQuery, setLastQuery] = createSignal<string | null>(null);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		const q = query().trim();
		if (!q || isLoading()) return;

		setIsLoading(true);
		setError(null);
		setResults([]);
		setLastQuery(q);

		try {
			const response = await fetch("/api/quicksearch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: q }),
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Search failed (${response.status}): ${text}`);
			}

			const data = (await response.json()) as { results: SearchResult[] };
			setResults(data.results);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<>
			<Header />
			<main class="search-layout">
				<section class="search-panel">
					<div class="search-header">
						<p class="eyebrow">Vector Search</p>
						<h1>Search Connecticut Statutes</h1>
						<p class="lead">
							Find relevant statute sections using semantic similarity search.
							For deeper analysis with AI-generated answers, try{" "}
							<a href="/deepsearch">Deep Search</a>.
						</p>
					</div>

					<form class="search-form" onSubmit={handleSubmit}>
						<label class="search-label" for="search-input">
							Search query
						</label>
						<div class="search-input-row">
							<input
								id="search-input"
								type="text"
								name="query"
								placeholder="Ex: penalties for unlicensed daycare"
								value={query()}
								onInput={(e) => setQuery(e.currentTarget.value)}
								disabled={isLoading()}
								required
							/>
							<button type="submit" disabled={isLoading()}>
								{isLoading() ? "Searching..." : "Search"}
							</button>
						</div>
					</form>

					<Show when={error()}>
						<div class="search-error">{error()}</div>
					</Show>

					<Show when={lastQuery() && !isLoading()}>
						<div class="search-results-header">
							<Show
								when={results().length > 0}
								fallback={<p>No results found for "{lastQuery()}"</p>}
							>
								<p>
									Found {results().length} results for "{lastQuery()}"
								</p>
							</Show>
						</div>
					</Show>

					<div class="search-results">
						<For each={results()}>
							{(result) => {
								const label = () =>
									result.section_label ?? result.section_number ?? "Section";
								const title = () =>
									result.section_title ? ` — ${result.section_title}` : "";
								const href = () => buildSectionHref(result.section_id);
								const snippet = () => {
									let text = result.text ?? "";
									// Strip title from beginning if present
									if (
										result.section_title &&
										text.startsWith(result.section_title)
									) {
										text = text
											.slice(result.section_title.length)
											.replace(/^[\s.]+/, "");
									}
									return text.slice(0, 300);
								};

								return (
									<div class="search-result-card">
										<div class="result-header">
											<span class="result-label">
												{label()}
												{title()}
											</span>
											<span class="result-score">
												{(result.score * 100).toFixed(1)}% match
											</span>
										</div>
										<div class="result-snippet">{snippet()}...</div>
										<Show when={href()}>
											{(h) => (
												<a class="result-link" href={h()}>
													View full section →
												</a>
											)}
										</Show>
									</div>
								);
							}}
						</For>
					</div>
				</section>
			</main>
		</>
	);
}
