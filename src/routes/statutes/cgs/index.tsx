import { A, cache, createAsync } from "@solidjs/router";
import { For, Show } from "solid-js";
import { Header } from "~/components/Header";
import { formatDesignator, getTitles } from "~/lib/db";

const loadTitles = cache(async () => {
	"use server";
	return getTitles();
}, "titles");

export const route = {
	load: () => loadTitles(),
};

export default function TitlesPage() {
	const titles = createAsync(() => loadTitles());

	const normalizeSlug = (value: string | null) => value?.toLowerCase();

	return (
		<>
			<Header />
			<main class="title-page">
				<section class="section-heading">
					<p class="eyebrow">Connecticut General Statutes</p>
					<h1>Titles</h1>
					<p class="lead">
						Browse by title, then drill into chapters and sections.
					</p>
				</section>

				<section class="section-block">
					<div class="section-title">
						<h2>All titles</h2>
					</div>
					<div class="section-list">
						<Show when={titles()} fallback={<p>Loading titles...</p>}>
							{(titleList) => (
								<For each={titleList()}>
									{(title) => (
										<A
											class="section-row"
											href={`/statutes/cgs/title/${normalizeSlug(title.id_display ?? title.id)}`}
										>
											<span class="section-number">
												Title {title.id_display ?? formatDesignator(title.id)}
											</span>
											<span class="section-title-text">
												{title.name ? `${title.name} · ` : ""}
												{title.chapter_count} chapters · {title.section_count}{" "}
												sections
											</span>
										</A>
									)}
								</For>
							)}
						</Show>
					</div>
				</section>
			</main>
		</>
	);
}
