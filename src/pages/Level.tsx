import { For, Show } from "solid-js";
import { Breadcrumbs } from "~/components/Breadcrumbs";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";
import type { LevelPageData, LevelRecord } from "~/lib/types";

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

const childUrl = (child: LevelRecord, sourceSlug: string): string => {
	if (child.doc_id && child.slug) {
		const parts = child.slug.split("/");
		if (parts.length >= 2) {
			const titleId = parts[parts.length - 2];
			const sectionId = parts[parts.length - 1];
			return `/statutes/${sourceSlug}/section/${titleId}/${sectionId}`;
		}
	}
	if (child.slug) {
		return `/${child.slug}`;
	}
	return "#";
};

type LevelPageProps = {
	data: Extract<LevelPageData, { status: "found" }>;
};

export function LevelPage(props: LevelPageProps) {
	const level = () => props.data.level;
	const source = () => props.data.source;
	const children = () => props.data.children ?? [];
	const ancestors = () => props.data.ancestors ?? [];

	const levelTypeLabel = () => {
		const lvl = level();
		return lvl.level_name.charAt(0).toUpperCase() + lvl.level_name.slice(1);
	};

	const formatLevelNumber = (identifier: string | null): string => {
		if (!identifier) return "";
		// Handle identifiers like "chap_417" -> "417", "title_21a" -> "21a"
		const match = identifier.match(/^[a-z]+_(.+)$/i);
		return match ? match[1] : identifier;
	};

	const heading = () => {
		const lvl = level();
		return `${levelTypeLabel()} ${formatLevelNumber(lvl.identifier)}`;
	};

	const currentBreadcrumbLabel = () => {
		const lvl = level();
		return `${levelTypeLabel()} ${formatLevelNumber(lvl.identifier)}`;
	};

	const subheading = () => level().name;

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
									<a class="section-row" href={childUrl(child, source().slug)}>
										<span class="section-number">
											{child.label ?? child.identifier}
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
