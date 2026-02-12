import { Title } from "@solidjs/meta";
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

const SOURCE_LINKS = [
	{
		label: "Connecticut General Statutes",
		href: "/statutes/cgs",
	},
	{
		label: "United States Code",
		href: "/statutes/usc",
	},
];

const SEARCH_TYPES = [
	{
		value: "auto",
		label: "Auto",
		description: "Automatically choose the best mode for the query.",
	},
	{
		value: "lookup",
		label: "Lookup",
		description: "Direct citation lookup, e.g. 42 USC 2001.",
	},
	{
		value: "structured",
		label: "Structured",
		description: "Terms-and-connectors style search.",
	},
	{
		value: "natural",
		label: "Natural",
		description: "Natural language question search.",
	},
] as const;

const buildSectionHref = (sectionId: string | null): string | null => {
	if (!sectionId || typeof sectionId !== "string") return null;
	const rawId = sectionId.replace(/^secs?_/, "");
	const [title, suffix] = rawId.split("-", 2);
	if (!title || !suffix) return null;
	return `/statutes/cgs/section/${title}/${suffix}`;
};

export default function SearchPage() {
	const [query, setQuery] = createSignal("");
	const [searchType, setSearchType] =
		createSignal<(typeof SEARCH_TYPES)[number]["value"]>("auto");
	const [isSearchTypeMenuOpen, setIsSearchTypeMenuOpen] = createSignal(false);
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
			<Title>Search - fast.law</Title>
			<Header />
			<main class="search-layout">
				<section class="search-panel">
					<form class="search-form" onSubmit={handleSubmit}>
						<label class="search-label" for="search-input">
							Search query
						</label>
						<div class="search-input-row">
							<div class="search-type-menu">
								<button
									type="button"
									class="search-type-trigger"
									aria-haspopup="menu"
									aria-expanded={isSearchTypeMenuOpen()}
									onClick={() => setIsSearchTypeMenuOpen((isOpen) => !isOpen)}
								>
									{
										SEARCH_TYPES.find((mode) => mode.value === searchType())
											?.label
									}
								</button>
								<Show when={isSearchTypeMenuOpen()}>
									<div class="search-type-options" role="menu">
										<For each={SEARCH_TYPES}>
											{(mode) => (
												<button
													type="button"
													role="menuitemradio"
													aria-checked={searchType() === mode.value}
													classList={{
														"search-type-option": true,
														active: searchType() === mode.value,
													}}
													onClick={() => {
														setSearchType(mode.value);
														setIsSearchTypeMenuOpen(false);
													}}
												>
													<span class="search-type-option-label">
														{mode.label}
													</span>
													<span class="search-type-option-description">
														{mode.description}
													</span>
												</button>
											)}
										</For>
									</div>
								</Show>
							</div>
							<input
								id="search-input"
								type="text"
								name="query"
								placeholder="Ex: tenant notice requirements"
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

					<section class="search-sources">
						<p class="search-sources-title">Sources</p>
						<ul class="search-sources-list">
							<For each={SOURCE_LINKS}>
								{(source) => (
									<li>
										<a href={source.href}>{source.label}</a>
									</li>
								)}
							</For>
						</ul>
					</section>

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
