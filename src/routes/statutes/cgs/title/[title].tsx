import { A, cache, createAsync, useParams } from "@solidjs/router";
import { For, Show } from "solid-js";
import { Header } from "~/components/Header";
import { getChaptersByTitleId } from "~/lib/db";

const loadChapters = cache(async (titleId: string) => {
	"use server";
	return getChaptersByTitleId(titleId);
}, "chapters-by-title");

export const route = {
	load: ({ params }: { params: { title: string } }) =>
		loadChapters(params.title),
};

export default function TitleDetailPage() {
	const params = useParams<{ title: string }>();
	const chapters = createAsync(() => loadChapters(params.title));

	const formatRange = (start: string | null, end: string | null) => {
		if (!start && !end) return null;
		if (!start) return end;
		if (!end || start === end) return start;
		return `${start}–${end}`;
	};

	return (
		<>
			<Header />
			<main class="title-page">
				<Show when={chapters()} fallback={<p>Loading...</p>}>
					{(chapterList) => {
						const titleDisplay = () =>
							chapterList()[0]?.title_id_display ?? params.title;
						const titleLabel = () => titleDisplay().toUpperCase();

						return (
							<>
								<section class="section-heading">
									<p class="eyebrow">Title {titleLabel()}</p>
									<h1>Chapters in Title {titleLabel()}</h1>
									<p class="lead">Open a chapter to explore its sections.</p>
								</section>

								<section class="section-block">
									<div class="section-title">
										<h2>Chapters</h2>
									</div>
									<div class="section-list">
										<For each={chapterList()}>
											{(chapter) => {
												const chapterSlug = () =>
													(
														chapter.id_display ??
														chapter.id.replace(/^chap_/, "")
													).toLowerCase();
												const chapterLabel = () =>
													chapter.id_display ??
													chapter.id.replace(/^chap_/, "").toUpperCase();
												const range = () =>
													formatRange(
														chapter.section_start,
														chapter.section_end,
													);

												return (
													<A
														class="section-row"
														href={`/statutes/cgs/chapter/${chapterSlug()}`}
													>
														<span class="section-number">
															Chapter {chapterLabel()}
														</span>
														<span class="section-title-text">
															{chapter.name}
															{range() ? ` · ${range()}` : ""}
															{` · ${chapter.section_count} sections`}
														</span>
													</A>
												);
											}}
										</For>
									</div>
								</section>
							</>
						);
					}}
				</Show>
			</main>
		</>
	);
}
