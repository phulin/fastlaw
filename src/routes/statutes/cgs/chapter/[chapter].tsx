import { A, cache, createAsync, useParams } from "@solidjs/router";
import { For, Show } from "solid-js";
import { Header } from "~/components/Header";
import { getChapterById, getSectionsByChapterId } from "~/lib/db";
import type { SectionRecord } from "~/lib/types";

const loadChapterData = cache(async (chapterId: string) => {
	"use server";
	const [chapter, sections] = await Promise.all([
		getChapterById(chapterId),
		getSectionsByChapterId(chapterId),
	]);
	return { chapter, sections };
}, "chapter-data");

export const route = {
	load: ({ params }: { params: { chapter: string } }) =>
		loadChapterData(params.chapter),
};

export default function ChapterDetailPage() {
	const params = useParams<{ chapter: string }>();
	const data = createAsync(() => loadChapterData(params.chapter));

	const buildSectionHref = (section: SectionRecord) => {
		const sectionNumber = section.section_number;
		if (!sectionNumber || !sectionNumber.includes("-")) return "#";
		const [titleSlug, suffix] = sectionNumber.split("-", 2);
		return `/statutes/cgs/section/${titleSlug}/${suffix}`;
	};

	return (
		<>
			<Header />
			<main class="chapter-page">
				<Show when={data()} fallback={<p>Loading...</p>}>
					{(d) => {
						const chapter = () => d().chapter;
						const sections = () => d().sections;
						const chapterDisplay = () =>
							chapter()?.id_display ?? params.chapter;
						const chapterLabel = () => chapterDisplay().toUpperCase();
						const titleDisplay = () =>
							chapter()?.title_id_display ?? chapter()?.title_id;
						const titleLabel = () => titleDisplay()?.toUpperCase();

						return (
							<>
								<section class="section-heading">
									<Show when={titleLabel()}>
										{(label) => (
											<div class="statute-breadcrumbs">
												<A
													href={`/statutes/cgs/title/${(titleDisplay() ?? "").toLowerCase()}`}
												>
													Title {label()}
												</A>
												<span class="crumb-sep">•</span>
												<span>Chapter {chapterLabel()}</span>
											</div>
										)}
									</Show>
									<h1>{chapter()?.name ?? `Chapter ${chapterLabel()}`}</h1>
								</section>

								<section class="section-block">
									<div class="section-title">
										<h2>Sections</h2>
									</div>
									<div class="section-list">
										<For each={sections()}>
											{(section) => (
												<A class="section-row" href={buildSectionHref(section)}>
													<span class="section-number">
														{section.section_number}
													</span>
													<span class="section-title-text">
														{section.heading ?? section.section_label}
													</span>
												</A>
											)}
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
