import { For } from "solid-js";
import type { NodeRecord, SourceRecord } from "~/lib/types";

interface BreadcrumbsProps {
	source: SourceRecord;
	ancestors: NodeRecord[];
	current?: { label: string };
	showHome?: boolean;
}

const formatAncestorLabel = (ancestor: NodeRecord): string => {
	const levelType =
		ancestor.level_name.charAt(0).toUpperCase() + ancestor.level_name.slice(1);
	if (ancestor.label) {
		return `${levelType} ${ancestor.label}`;
	}
	return levelType;
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
			<a href={`/statutes/${props.source.code}`}>{props.source.name}</a>
			<For each={ancestorsWithoutCurrent()}>
				{(ancestor) => (
					<>
						<span class="crumb-sep">/</span>
						<a href={`/statutes/${props.source.code}/${ancestor.slug}`}>
							{formatAncestorLabel(ancestor)}
						</a>
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
