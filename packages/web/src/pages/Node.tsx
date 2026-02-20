import { Title } from "@solidjs/meta";
import { For, onMount, Show } from "solid-js";
import { Breadcrumbs } from "~/components/Breadcrumbs";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";
import { renderMarkdown } from "~/lib/markdown";
import { toStatuteRoutePath } from "~/lib/routes";
import { capitalizeWords, pluralize } from "~/lib/text";
import type { NodeRecord, PageData } from "~/lib/types";

const toTitle = (value: string) =>
	value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const navLabel = (node: NodeRecord | null) => {
	if (node?.heading_citation && node?.name) {
		return `${node.heading_citation}. ${node?.name}`;
	} else {
		return node?.name ?? node?.id ?? "Section";
	}
};

type NodePageProps = {
	data: Extract<PageData, { status: "found" }>;
};

export function NodePage(props: NodePageProps) {
	const node = () => props.data.node;
	const source = () => props.data.source;
	const content = () => props.data.content;
	const children = () => props.data.children ?? [];
	const ancestors = () => props.data.ancestors ?? [];
	const nav = () => props.data.nav;
	const siblings = () => props.data.siblings ?? [];
	const statuteRoutePrefix = () => props.data.statuteRoutePrefix;

	const isSection = () => node().level_name === "section";

	const heading = () => {
		const n = node();
		const levelType = capitalizeWords(n.level_name);

		if (n.name && n.level_index < 0) {
			return n.name;
		}

		// Use heading_citation if available
		if (n.heading_citation) {
			return n.name
				? `${n.heading_citation}. ${n.name}`
				: `${n.heading_citation}.`;
		}

		if (n.readable_id) {
			return n.name
				? `${levelType} ${n.readable_id}. ${n.name}`
				: `${levelType} ${n.readable_id}.`;
		}
		return levelType;
	};

	const pageTitle = () => {
		const h = heading();
		const title = isSection() ? h.replace(/^Section\s+/i, "") : h;
		const suffix = " - fast.law";
		const maxTitleLen = 55 - 3 - suffix.length; // room for ellipsis
		const words = title.split(" ");
		let result = "";
		for (const word of words) {
			if (`${result} ${word}`.trim().length <= maxTitleLen) {
				result = result ? `${result} ${word}` : word;
			} else {
				break;
			}
		}
		if (result !== title) {
			return `${result}...${suffix}`;
		}
		return `${title}${suffix}`;
	};

	const bodyBlocks = () =>
		content()?.blocks.filter((block) => block.type === "body") ?? [];
	const metaBlocks = () =>
		content()?.blocks.filter((block) => block.type !== "body") ?? [];
	const tocItems = () => {
		const items = [];
		if (content()) {
			items.push({ id: "statute-body", label: "Text" });
			items.push(
				...metaBlocks().map((block, index) => ({
					id: `statute-meta-${index}`,
					label: block.label ?? toTitle(block.type),
				})),
			);
		}
		if (children().length > 0) {
			const first = children()[0];
			items.push({
				id: "children",
				label: pluralize(
					children().length,
					capitalizeWords(first?.level_name ?? "item"),
				),
			});
		}
		return items;
	};

	const hasSiblingToc = () => isSection() && siblings().length > 1;

	const parentNode = () => {
		const ancs = ancestors();
		return ancs.length > 1 ? ancs[ancs.length - 2] : null;
	};

	const parentLabel = () => {
		const parent = parentNode();
		if (!parent) return null;
		const id = parent.readable_id ?? parent.id;
		const levelType = capitalizeWords(parent.level_name);
		return parent.name ? `${levelType} ${id}. ${parent.name}` : id;
	};

	const childLevelName = () => {
		const first = children()[0];
		return first?.level_name ?? "item";
	};

	const prevNode = () => nav()?.prev ?? null;
	const nextNode = () => nav()?.next ?? null;
	const markdownOptions = () => ({
		statuteRoutePrefix: statuteRoutePrefix(),
		sourceCode: source().id,
	});

	let tocListRef: HTMLDivElement | undefined;
	onMount(() => {
		const active = tocListRef?.querySelector(".toc-item.active");
		active?.scrollIntoView({ block: "center" });
	});

	return (
		<>
			<Title>{pageTitle()}</Title>
			<Header />
			<main
				class={`section-page${hasSiblingToc() || tocItems().length > 1 ? " with-toc" : ""}`}
			>
				<Show when={hasSiblingToc()}>
					<aside class="toc">
						<div class="toc-panel">
							<div class="toc-header">{parentLabel()}</div>
							<div class="toc-list toc-list-sibling" ref={tocListRef}>
								<For each={siblings()}>
									{(sibling) => (
										<a
											class={`toc-item${sibling.id === node().id ? " active" : ""}`}
											href={
												toStatuteRoutePath(
													statuteRoutePrefix(),
													sibling.path,
												) ?? "#"
											}
										>
											<span class="toc-title">
												{sibling.readable_id ?? sibling.id}
												{sibling.name ? `. ${sibling.name}` : ""}
											</span>
										</a>
									)}
								</For>
							</div>
						</div>
					</aside>
				</Show>
				<Show when={!hasSiblingToc() && tocItems().length > 1}>
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
				</Show>
				<section class="statute">
					<div class="statute-header">
						<Breadcrumbs
							source={source()}
							ancestors={ancestors()}
							routePrefix={statuteRoutePrefix()}
							showHome={!isSection()}
						/>
						<h1>{heading()}</h1>
					</div>

					{/* Body content */}
					<Show when={content()}>
						<div id="statute-body" class="statute-body">
							<For each={bodyBlocks()}>
								{(block) => {
									return (
										<div
											class="markdown"
											innerHTML={renderMarkdown(
												block.content ?? "",
												markdownOptions(),
											)}
										/>
									);
								}}
							</For>
						</div>
						<Show when={metaBlocks().length > 0}>
							<div class="statute-meta">
								<For each={metaBlocks()}>
									{(block, index) =>
										block.type === "heading" ? (
											<h3 id={`statute-meta-${index()}`}>
												{block.label ?? toTitle(block.type)}
											</h3>
										) : (
											<div
												id={`statute-meta-${index()}`}
												class={`meta-block meta-block-${block.type}`}
											>
												<p class="level-marker">
													{block.label ?? toTitle(block.type)}
												</p>
												<Show when={block.content}>
													<div
														class="markdown"
														innerHTML={renderMarkdown(
															block.content ?? "",
															markdownOptions(),
														)}
													/>
												</Show>
											</div>
										)
									}
								</For>
							</div>
						</Show>
					</Show>

					{/* Children */}
					<Show when={children().length > 0}>
						<div id="children" class="level-children">
							<h2>{capitalizeWords(childLevelName())}</h2>
							<div class="section-list">
								<For each={children()}>
									{(child) => (
										<a
											class="section-row"
											href={
												toStatuteRoutePath(statuteRoutePrefix(), child.path) ??
												"#"
											}
										>
											<span class="section-number">
												{child.readable_id ?? child.id}
											</span>
											<span class="section-title-text">{child.name}</span>
										</a>
									)}
								</For>
							</div>
						</div>
					</Show>

					{/* Navigation */}
					<Show when={nav()}>
						<div class="statute-nav">
							<Show when={prevNode()}>
								<a
									class="statute-nav-link"
									href={
										toStatuteRoutePath(
											statuteRoutePrefix(),
											prevNode()?.path,
										) ?? "#"
									}
								>
									<span class="statute-nav-label">Previous</span>
									<span>{navLabel(prevNode())}</span>
								</a>
							</Show>
							<Show when={nextNode()}>
								<a
									class="statute-nav-link"
									href={
										toStatuteRoutePath(
											statuteRoutePrefix(),
											nextNode()?.path,
										) ?? "#"
									}
								>
									<span class="statute-nav-label">Next</span>
									<span>{navLabel(nextNode())}</span>
								</a>
							</Show>
						</div>
					</Show>
				</section>
			</main>
			<Footer />
		</>
	);
}
