import { For, Show } from "solid-js";
import type { DocData } from "~/App";
import { Breadcrumbs } from "~/components/Breadcrumbs";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";

const toTitle = (value: string) =>
	value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const splitParagraphs = (text: string) =>
	text
		.split(/\n\s*\n/g)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);

const identifierToken = "(?:[ivxIVX]+|\\d+|[A-Za-z]{1,3})";
const identifierPattern = new RegExp(
	`^(\\(${identifierToken}\\)|${identifierToken}\\.)(\\s+)`,
);

const splitLeadingIdentifier = (text: string) => {
	const trimmed = text.trimStart();
	const match = trimmed.match(identifierPattern);
	if (!match) return { leading: null, rest: text };
	return {
		leading: match[1],
		rest: trimmed.slice(match[0].length),
	};
};

const getIndentClass = (text: string) => {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("(")) return "indent-0";
	const token = trimmed.slice(1).split(")")[0] ?? "";
	if (/^[a-z]$/i.test(token)) return "indent-1";
	if (/^\d+$/.test(token)) return "indent-2";
	if (/^[ivx]+$/i.test(token)) return "indent-3";
	if (/^[A-Z]$/.test(token)) return "indent-4";
	return "indent-1";
};

const toSectionPath = (
	node: { slug: string | null; string_id: string } | null,
	sourceCode: string,
) => {
	if (!node?.slug) return null;
	return `/statutes/${sourceCode}/${node.slug}`;
};

const getSlugSection = (slug: string) => {
	const parts = slug.split("/");
	if (parts.length < 2) return slug;
	const titleId = parts[parts.length - 2];
	const sectionId = parts[parts.length - 1];
	return titleId && sectionId ? `${titleId}-${sectionId}` : slug;
};

const navLabel = (
	node: { label: string | null; name: string | null; string_id: string } | null,
) => node?.label ?? node?.name ?? node?.string_id ?? "Section";

type DocumentPageProps = {
	doc: Extract<DocData, { status: "found" }>;
};

export function DocumentPage(props: DocumentPageProps) {
	const bodyBlocks = () =>
		props.doc.content.blocks.filter((block) => block.type === "body");
	const metaBlocks = () =>
		props.doc.content.blocks.filter((block) => block.type !== "body");
	const tocItems = () => [
		{ id: "statute-body", label: "Text" },
		...metaBlocks().map((block, index) => ({
			id: `statute-meta-${index}`,
			label: block.label ?? toTitle(block.type),
		})),
	];
	const heading = () =>
		props.doc.node.name ?? props.doc.node.label ?? "Statute text";
	const sectionNumber = () =>
		props.doc.node.label ?? getSlugSection(props.doc.slug);
	const prevNode = () => props.doc.nav?.prev ?? null;
	const nextNode = () => props.doc.nav?.next ?? null;
	const sourceCode = () => props.doc.source.code;

	return (
		<>
			<Header />
			<main class="section-page with-toc">
				<aside class="toc">
					<details class="toc-panel" open>
						<summary class="toc-summary">On this page</summary>
						<div class="toc-list">
							<For each={tocItems()}>
								{(item) => (
									<a class="toc-item" href={`#${item.id}`}>
										<span class="toc-title">{item.label}</span>
									</a>
								)}
							</For>
						</div>
					</details>
				</aside>
				<section class="statute">
					<div class="statute-header">
						<Breadcrumbs
							source={props.doc.source}
							ancestors={props.doc.ancestors}
							current={{ label: sectionNumber() }}
						/>
						<h1>{`Section ${sectionNumber()}`}</h1>
						<p class="lead">{heading()}</p>
					</div>
					<div id="statute-body" class="statute-body">
						<For each={bodyBlocks()}>
							{(block) => (
								<For each={splitParagraphs(block.content)}>
									{(paragraph) => {
										const parts = splitLeadingIdentifier(paragraph);
										return (
											<p class={getIndentClass(paragraph)}>
												{parts.leading ? (
													<>
														<strong class="paragraph-identifier">
															{parts.leading}
														</strong>
														{parts.rest ? ` ${parts.rest}` : ""}
													</>
												) : (
													paragraph
												)}
											</p>
										);
									}}
								</For>
							)}
						</For>
					</div>
					<Show when={metaBlocks().length > 0}>
						<div class="statute-meta">
							<h2>Additional context</h2>
							<For each={metaBlocks()}>
								{(block, index) => (
									<div id={`statute-meta-${index()}`}>
										<p class="level-marker">
											{block.label ?? toTitle(block.type)}
										</p>
										<For each={splitParagraphs(block.content)}>
											{(paragraph) => {
												const parts = splitLeadingIdentifier(paragraph);
												return (
													<p>
														{parts.leading ? (
															<>
																<strong class="paragraph-identifier">
																	{parts.leading}
																</strong>
																{parts.rest ? ` ${parts.rest}` : ""}
															</>
														) : (
															paragraph
														)}
													</p>
												);
											}}
										</For>
									</div>
								)}
							</For>
						</div>
					</Show>
					<div class="statute-nav">
						<Show when={prevNode()}>
							<a
								class="statute-nav-link"
								href={toSectionPath(prevNode(), sourceCode()) ?? "#"}
							>
								<span class="statute-nav-label">Previous</span>
								<span>{navLabel(prevNode())}</span>
							</a>
						</Show>
						<Show when={nextNode()}>
							<a
								class="statute-nav-link"
								href={toSectionPath(nextNode(), sourceCode()) ?? "#"}
							>
								<span class="statute-nav-label">Next</span>
								<span>{navLabel(nextNode())}</span>
							</a>
						</Show>
					</div>
				</section>
			</main>
			<Footer />
		</>
	);
}
