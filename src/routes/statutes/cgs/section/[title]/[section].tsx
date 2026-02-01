import { A, cache, createAsync, useParams } from "@solidjs/router";
import { For, Show } from "solid-js";
import { Header } from "~/components/Header";
import {
	getChapterById,
	getSectionByNumber,
	getSectionContent,
	getSectionsByChapterId,
} from "~/lib/db";
import type { ChapterRecord, SectionContent, SectionRecord } from "~/lib/types";

interface SectionData {
	section: SectionRecord;
	content: SectionContent | null;
	chapter: ChapterRecord | null;
	chapterSections: SectionRecord[];
}

const loadSectionData = cache(
	async (
		titleId: string,
		sectionSuffix: string,
	): Promise<SectionData | null> => {
		"use server";
		const section = await getSectionByNumber(titleId, sectionSuffix);
		if (!section) return null;

		const [content, chapter, chapterSections] = await Promise.all([
			getSectionContent(section.r2_key),
			section.chapter_id ? getChapterById(section.chapter_id) : null,
			section.chapter_id ? getSectionsByChapterId(section.chapter_id) : [],
		]);

		return { section, content, chapter, chapterSections };
	},
	"section-data",
);

export const route = {
	load: ({ params }: { params: { title: string; section: string } }) =>
		loadSectionData(params.title, params.section),
};

// Marker pattern for statute subsections
const markerPattern = /^\((?:\d+|[a-z]|[A-Z]|[ivx]+|[IVX]+)\)/;

const getIndentLevel = (marker: string): number => {
	if (/^\([a-z]\)/.test(marker)) return 1;
	if (/^\(\d+\)/.test(marker)) return 2;
	if (/^\([A-Z]\)/.test(marker)) return 3;
	if (/^\([ivx]+\)/.test(marker)) return 4;
	if (/^\([IVX]+\)/.test(marker)) return 5;
	return 0;
};

interface BodyLine {
	marker: string | null;
	text: string;
	level: number;
}

const splitParagraph = (paragraph: string): BodyLine[] => {
	let remaining = paragraph.trim();
	const markers: string[] = [];

	while (markerPattern.test(remaining)) {
		const match = remaining.match(markerPattern);
		if (!match) break;
		markers.push(match[0]);
		remaining = remaining.slice(match[0].length).trimStart();
	}

	if (markers.length === 0) {
		return [{ marker: null, text: paragraph, level: 0 }];
	}

	return markers.map((marker, index) => ({
		marker,
		text: index === markers.length - 1 ? remaining : "",
		level: getIndentLevel(marker),
	}));
};

// Linkify section references
const statuteTokenRegex = /\b\d+[a-z]?-?\d+[0-9a-z-]*\b/gi;

const buildSectionHref = (sectionNumber: string): string | null => {
	if (!sectionNumber || !sectionNumber.includes("-")) return null;
	const [title, suffix] = sectionNumber.split("-", 2);
	if (!title || !suffix) return null;
	return `/statutes/cgs/section/${title}/${suffix}`;
};

const shouldLinkToken = (
	text: string,
	index: number,
	token: string,
): boolean => {
	if (!token.includes("-")) return false;
	const prefix = text.slice(Math.max(0, index - 20), index).toLowerCase();
	if (/(public|special)\s+act\s*$/.test(prefix)) return false;
	if (/p\.a\.\s*$/.test(prefix)) return false;
	return true;
};

type LinkPart =
	| { type: "text"; text: string }
	| { type: "link"; text: string; href: string };

const linkifySections = (text: string): LinkPart[] => {
	const output: LinkPart[] = [];
	let lastIndex = 0;

	for (const match of text.matchAll(statuteTokenRegex)) {
		const full = match[0];
		const startIndex = match.index ?? 0;

		if (startIndex > lastIndex) {
			output.push({ type: "text", text: text.slice(lastIndex, startIndex) });
		}

		if (shouldLinkToken(text, startIndex, full)) {
			const href = buildSectionHref(full);
			if (href) {
				output.push({ type: "link", text: full, href });
			} else {
				output.push({ type: "text", text: full });
			}
		} else {
			output.push({ type: "text", text: full });
		}
		lastIndex = startIndex + full.length;
	}

	if (lastIndex < text.length) {
		output.push({ type: "text", text: text.slice(lastIndex) });
	}

	return output;
};

// Collapse colon-ending lines with following lines
const collapseColonLines = (items: string[]): string[] => {
	const merged: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const current = items[i];
		if (current.endsWith(":") && i + 1 < items.length) {
			merged.push(`${current} ${items[i + 1]}`.replace(/\s+/g, " ").trim());
			i++;
			continue;
		}
		merged.push(current);
	}
	return merged;
};

function LinkifiedText(props: { text: string }) {
	const parts = () => linkifySections(props.text);
	return (
		<For each={parts()}>
			{(part) =>
				part.type === "link" ? <A href={part.href}>{part.text}</A> : part.text
			}
		</For>
	);
}

export default function SectionDetailPage() {
	const params = useParams<{ title: string; section: string }>();
	const data = createAsync(() => loadSectionData(params.title, params.section));

	const buildSectionIdHref = (sectionId: string | null) => {
		if (!sectionId) return null;
		const rawId = sectionId.replace(/^secs?_/, "");
		const [title, suffix] = rawId.split("-", 2);
		if (!title || !suffix) return null;
		return `/statutes/cgs/section/${title}/${suffix}`;
	};

	return (
		<>
			<Header />
			<Show when={data()} fallback={<p>Loading section...</p>}>
				{(d) => {
					const section = () => d().section;
					const content = () => d().content;
					const chapter = () => d().chapter;
					const chapterSections = () => d().chapterSections;

					// Extract content blocks
					const bodyBlock = () =>
						content()?.blocks.find((b) => b.type === "body");
					const historyShortBlock = () =>
						content()?.blocks.find((b) => b.type === "history_short");
					const historyLongBlock = () =>
						content()?.blocks.find((b) => b.type === "history_long");
					const citationsBlock = () =>
						content()?.blocks.find((b) => b.type === "citations");

					// Parse body into lines with indentation
					const bodyLines = () => {
						const body = bodyBlock()?.content ?? "";
						const paragraphs = body.split("\n\n").filter(Boolean);
						return paragraphs.flatMap(splitParagraph);
					};

					// Parse history
					const historyShort = () =>
						historyShortBlock()?.content?.split("\n").filter(Boolean) ?? [];
					const historyLong = () =>
						historyLongBlock()?.content?.split("\n").filter(Boolean) ?? [];

					// Parse citations
					const citations = () => {
						const raw =
							citationsBlock()?.content?.split("\n").filter(Boolean) ?? [];
						return collapseColonLines(raw);
					};

					// Parse see also
					const seeAlso = () =>
						section().see_also?.split("\n").filter(Boolean) ?? [];

					// Chapter/title display
					const chapterSlug = () =>
						chapter()?.id_display ??
						section().chapter_id?.replace(/^chap_/, "");
					const chapterLabel = () =>
						chapter()?.id_display
							? chapter()?.id_display?.toUpperCase()
							: chapterSlug()?.toUpperCase();
					const titleSlug = () =>
						chapter()?.title_id_display ??
						section().title_id ??
						section().section_number?.split("-", 1)[0];
					const titleLabel = () =>
						chapter()?.title_id_display
							? chapter()?.title_id_display?.toUpperCase()
							: titleSlug()?.toUpperCase();

					return (
						<main class="section-page with-toc">
							<aside class="toc">
								<details class="toc-panel" open>
									<summary class="toc-summary">
										{chapterLabel()
											? `Chapter ${chapterLabel()} Contents`
											: "Chapter Contents"}
									</summary>
									<div class="toc-list">
										<For each={chapterSections()}>
											{(item) =>
												item.id === section().id ? (
													<div class="toc-item active" data-active="true">
														<span>{item.section_number}</span>
														<span class="toc-title">
															{item.heading ?? item.section_label}
														</span>
													</div>
												) : (
													<A
														class="toc-item"
														data-active="false"
														href={
															buildSectionIdHref(item.section_number) ?? "#"
														}
													>
														<span>{item.section_number}</span>
														<span class="toc-title">
															{item.heading ?? item.section_label}
														</span>
													</A>
												)
											}
										</For>
									</div>
								</details>
							</aside>

							<article class="statute">
								<header class="statute-header">
									<div class="statute-breadcrumbs">
										<Show when={titleSlug()}>
											<A
												href={`/statutes/cgs/title/${titleSlug()?.toLowerCase()}`}
											>
												Title {titleLabel()}
											</A>
										</Show>
										<Show when={chapterSlug() && titleSlug()}>
											<span class="crumb-sep">•</span>
										</Show>
										<Show when={chapterSlug()}>
											<A
												href={`/statutes/cgs/chapter/${chapterSlug()?.toLowerCase()}`}
											>
												{chapter()?.name
													? `Chapter ${chapterLabel()} • ${chapter()?.name}`
													: `Chapter ${chapterLabel()}`}
											</A>
										</Show>
									</div>
									<h1>{section().section_label}</h1>
								</header>

								<div class="statute-body">
									<For each={bodyLines()}>
										{(line) => (
											<p class={`indent-${line.level}`}>
												<Show when={line.marker}>
													<strong class="level-marker">{line.marker}</strong>
												</Show>
												{line.marker && line.text ? " " : ""}
												<LinkifiedText text={line.text} />
											</p>
										)}
									</For>
								</div>

								<Show when={historyShort().length > 0}>
									<section class="statute-meta">
										<h2>History</h2>
										<For each={historyShort()}>
											{(line) => (
												<p>
													<LinkifiedText text={line} />
												</p>
											)}
										</For>
									</section>
								</Show>

								<Show when={historyLong().length > 0}>
									<section class="statute-meta">
										<h2>History Notes</h2>
										<For each={historyLong()}>
											{(line) => (
												<p>
													<LinkifiedText text={line} />
												</p>
											)}
										</For>
									</section>
								</Show>

								<Show when={citations().length > 0}>
									<section class="statute-meta">
										<h2>Citations</h2>
										<ul>
											<For each={citations()}>
												{(item) => (
													<li>
														<LinkifiedText text={item} />
													</li>
												)}
											</For>
										</ul>
									</section>
								</Show>

								<Show when={seeAlso().length > 0}>
									<section class="statute-meta">
										<h2>See also</h2>
										<ul>
											<For each={seeAlso()}>
												{(item) => (
													<li>
														<LinkifiedText text={item} />
													</li>
												)}
											</For>
										</ul>
									</section>
								</Show>

								<Show
									when={section().prev_section_id || section().next_section_id}
								>
									<nav class="statute-nav">
										<Show when={section().prev_section_id}>
											<A
												class="statute-nav-link"
												href={
													buildSectionIdHref(section().prev_section_id) ?? "#"
												}
											>
												<span class="statute-nav-label">Previous</span>
												<span>
													{section().prev_section_label ??
														section().prev_section_id}
												</span>
											</A>
										</Show>
										<Show when={section().next_section_id}>
											<A
												class="statute-nav-link"
												href={
													buildSectionIdHref(section().next_section_id) ?? "#"
												}
											>
												<span class="statute-nav-label">Next</span>
												<span>
													{section().next_section_label ??
														section().next_section_id}
												</span>
											</A>
										</Show>
									</nav>
								</Show>
							</article>
						</main>
					);
				}}
			</Show>
		</>
	);
}
