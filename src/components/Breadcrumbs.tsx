import { For } from "solid-js";
import type { LevelRecord, SourceRecord } from "~/lib/types";

interface BreadcrumbsProps {
	source: SourceRecord;
	ancestors: LevelRecord[];
	current?: { label: string };
	showHome?: boolean;
}

const formatLevelNumber = (identifier: string | null): string => {
	if (!identifier) return "";
	// Handle identifiers like "chap_417" -> "417", "title_21a" -> "21a"
	const match = identifier.match(/^[a-z]+_(.+)$/i);
	return match ? match[1] : identifier;
};

const formatAncestorLabel = (ancestor: LevelRecord): string => {
	const levelType =
		ancestor.level_name.charAt(0).toUpperCase() + ancestor.level_name.slice(1);
	return `${levelType} ${formatLevelNumber(ancestor.identifier)}`;
};

export function Breadcrumbs(props: BreadcrumbsProps) {
	const ancestorsWithoutCurrent = () => {
		if (!props.current) return props.ancestors;
		return props.ancestors.slice(0, -1);
	};

	return (
		<div class="statute-breadcrumbs">
			{props.showHome !== false && (
				<>
					<a href="/">Home</a>
					<span class="crumb-sep">/</span>
				</>
			)}
			<a href={`/statutes/${props.source.slug}`}>{props.source.name}</a>
			<For each={ancestorsWithoutCurrent()}>
				{(ancestor) => (
					<>
						<span class="crumb-sep">/</span>
						<a href={`/${ancestor.slug}`}>{formatAncestorLabel(ancestor)}</a>
					</>
				)}
			</For>
			{props.current && (
				<>
					<span class="crumb-sep">/</span>
					<span>{props.current.label}</span>
				</>
			)}
		</div>
	);
}
