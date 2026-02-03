import { For, Show } from "solid-js";
import type { NodeRecord, SourceRecord } from "~/lib/types";

interface BreadcrumbsProps {
	source: SourceRecord;
	ancestors: NodeRecord[];
	showHome?: boolean;
}

const formatAncestorLabel = (ancestor: NodeRecord): string => {
	const levelType =
		ancestor.level_name.charAt(0).toUpperCase() + ancestor.level_name.slice(1);
	if (ancestor.label && ancestor.level_index < 0) {
		return ancestor.label;
	} else if (ancestor.readable_id) {
		return `${levelType} ${ancestor.readable_id}`;
	} else {
		return levelType;
	}
};

export function Breadcrumbs(props: BreadcrumbsProps) {
	return (
		<div class="statute-breadcrumbs">
			{props.showHome !== false && (
				<>
					<a href="/">Home</a>
					<span class="crumb-sep">/</span>
				</>
			)}
			<For each={props.ancestors}>
				{(ancestor, index) => (
					<>
						{index() > 0 && <span class="crumb-sep">/</span>}
						<a href={`/${ancestor.path}`}>{formatAncestorLabel(ancestor)}</a>
					</>
				)}
			</For>
		</div>
	);
}
