import { For, Show } from "solid-js";
import { Breadcrumbs } from "~/components/Breadcrumbs";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";
import type { LevelPageData, NodeRecord } from "~/lib/types";

const levelDisplayName = (levelName: string): string => {
	const names: Record<string, string> = {
		title: "Titles",
		chapter: "Chapters",
		section: "Sections",
		part: "Parts",
		subchapter: "Subchapters",
	};
	return names[levelName] ?? levelName;
};

const childUrl = (child: NodeRecord, sourceCode: string): string => {
	// Check if this is a leaf node (section) with content
	if (child.blob_key && child.slug) {
		return `/statutes/${sourceCode}/${child.slug}`;
	}
	if (child.slug) {
		return `/statutes/${sourceCode}/${child.slug}`;
	}
	return "#";
};

type LevelPageProps = {
	data: Extract<LevelPageData, { status: "found" }>;
};

export function LevelPage(props: LevelPageProps) {
	const node = () => props.data.node;
	const source = () => props.data.source;
	const children = () => props.data.children ?? [];
	const ancestors = () => props.data.ancestors ?? [];

	const levelTypeLabel = () => {
		const n = node();
		return n.level_name.charAt(0).toUpperCase() + n.level_name.slice(1);
	};

	const formatLabel = (label: string | null): string => {
		if (!label) return "";
		return label;
	};

	const heading = () => {
		const n = node();
		if (n.label) {
			return `${levelTypeLabel()} ${formatLabel(n.label)}`;
		}
		return levelTypeLabel();
	};

	const currentBreadcrumbLabel = () => {
		const n = node();
		if (n.label) {
			return `${levelTypeLabel()} ${formatLabel(n.label)}`;
		}
		return levelTypeLabel();
	};

	const subheading = () => node().name;

	const childLevelName = () => {
		const first = children()[0];
		return first?.level_name ?? "item";
	};

	return (
		<>
			<Header />
			<main class="section-page">
				<section class="statute">
					<div class="statute-header">
						<Breadcrumbs
							source={source()}
							ancestors={ancestors()}
							current={{ label: currentBreadcrumbLabel() }}
							showHome={false}
						/>
						<h1>{heading()}</h1>
						<Show when={subheading()}>
							<p class="lead">{subheading()}</p>
						</Show>
					</div>

					<div class="level-children">
						<h2>{levelDisplayName(childLevelName())}</h2>
						<div class="section-list">
							<For each={children()}>
								{(child) => (
									<a class="section-row" href={childUrl(child, source().code)}>
										<span class="section-number">
											{child.label ?? child.string_id}
										</span>
										<span class="section-title-text">{child.name}</span>
									</a>
								)}
							</For>
						</div>
					</div>
				</section>
			</main>
			<Footer />
		</>
	);
}
