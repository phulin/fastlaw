import type { Root, RootContent } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Node, Parent } from "unist";
import { visit } from "unist-util-visit";

const MAX_INDENT_DEPTH = 5;
const STATUTES_PREFIX = "/statutes/";
const INSERTED_CLASS = "pdf-amended-snippet-inserted";
const DELETED_CLASS = "pdf-amended-snippet-deleted";

export interface MarkdownReplacementRange {
	start: number;
	end: number;
	deletedText: string;
}

type RenderMarkdownOptions = {
	statuteRoutePrefix?: string;
	sourceCode?: string;
	replacements?: MarkdownReplacementRange[];
};

type NodeWithPosition = Node & {
	position?: {
		start?: { offset?: number };
		end?: { offset?: number };
	};
};

type ParentWithChildren = Parent & {
	children: RootContent[];
};

const parseProcessor = unified().use(remarkParse).use(remarkGfm);
const renderProcessor = unified()
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeStringify, { allowDangerousHtml: true });

const hasChildren = (node: Node): node is ParentWithChildren =>
	Array.isArray((node as Parent).children);

const rewriteStatuteHref = (
	href: string,
	options: RenderMarkdownOptions,
): string => {
	const { statuteRoutePrefix, sourceCode } = options;
	if (!statuteRoutePrefix || !href.startsWith("/statutes/")) {
		return href;
	}

	const [, pathPart = "", query = "", hash = ""] =
		href.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/) ?? [];
	if (!pathPart.startsWith(STATUTES_PREFIX)) {
		return href;
	}

	let tail = pathPart.slice(STATUTES_PREFIX.length);
	if (!tail) {
		return `${statuteRoutePrefix}${query}${hash}`;
	}

	if (sourceCode) {
		const [first, ...rest] = tail.split("/");
		if (first === sourceCode || first.startsWith(`${sourceCode}@`)) {
			tail = rest.join("/");
		}
	}

	const joinedTail = tail.length > 0 ? `/${tail}` : "";
	return `${statuteRoutePrefix}${joinedTail}${query}${hash}`;
};

const escapeHtml = (input: string): string =>
	input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

const htmlNode = (value: string): RootContent =>
	({ type: "html", value }) as unknown as RootContent;

const textNode = (value: string): RootContent =>
	({ type: "text", value }) as unknown as RootContent;

const strongNode = (value: string): RootContent =>
	({
		type: "strong",
		children: [{ type: "text", value }],
	}) as unknown as RootContent;

const paragraphNode = (children: RootContent[]): RootContent =>
	({ type: "paragraph", children }) as unknown as RootContent;

const sanitizeIndentClass = (value?: string): string | null =>
	value && /^indent\d+$/.test(value) ? value : null;

const paragraphClassAttr = (indentClass?: string): string => {
	const safeIndentClass = sanitizeIndentClass(indentClass);
	return safeIndentClass ? ` class="${safeIndentClass}"` : "";
};

const MARKER_START_RE = /^\s*\([A-Za-z0-9ivxIVX]+\)/;
const startsWithMarker = (value: string): boolean =>
	MARKER_START_RE.test(value);

const expandSingleLineBreaks = (input: string): string => {
	if (input.length === 0) return input;
	let output = "";
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (char !== "\n") {
			output += char;
			continue;
		}
		const prevChar = index > 0 ? input[index - 1] : "";
		const nextChar = index + 1 < input.length ? input[index + 1] : "";
		const isSingleBreak = prevChar !== "\n" && nextChar !== "\n";
		output += isSingleBreak ? "\n\n" : "\n";
	}
	return output;
};

const HEADING_WITH_DASH_RE =
	/^\(([^)]+)\)\s+([A-Z0-9][A-Z0-9 '"()\-.,/&]*?)(\.\u2014)([\s\S]*)$/;

const emphasizeInsertedMarkerHeadings = (tree: Root) => {
	visit(tree as Node, "paragraph", (node) => {
		const paragraph = node as ParentWithChildren;
		if (paragraph.children.length !== 1) return;
		const onlyChild = paragraph.children[0] as Node & { value?: string };
		if (onlyChild.type !== "text" || typeof onlyChild.value !== "string")
			return;
		const match = onlyChild.value.match(HEADING_WITH_DASH_RE);
		if (!match) return;
		const marker = match[1] ?? "";
		const heading = (match[2] ?? "").trim();
		const punctuation = match[3] ?? "";
		const tail = match[4] ?? "";
		if (marker.length === 0 || heading.length === 0) return;
		paragraph.children = [
			strongNode(`(${marker})`),
			textNode(" "),
			strongNode(heading),
			textNode(`${punctuation}${tail}`),
		];
	});
};

const renderInsertedHtml = (value: string): string => {
	const normalizedValue = value.includes("\n")
		? expandSingleLineBreaks(value)
		: value;
	const parsed = parseProcessor.parse(normalizedValue) as Root;
	emphasizeInsertedMarkerHeadings(parsed);
	const hastTree = renderProcessor.runSync(parsed);
	const rendered = String(renderProcessor.stringify(hastTree));
	if (!value.includes("\n")) {
		return rendered.replace(/^<p[^>]*>/, "").replace(/<\/p>\s*$/, "");
	}
	return rendered;
};

const wrapInsHtml = (
	value: string,
	indentClass?: string,
	options?: { allowMarkerStartWrap?: boolean },
): string => {
	if (!value.includes("\n")) {
		const rendered = renderInsertedHtml(value);
		return `<ins class="${INSERTED_CLASS}">${rendered}</ins>`;
	}

	if (startsWithMarker(value) && options?.allowMarkerStartWrap !== false) {
		const firstLineBreak = value.indexOf("\n");
		const wrappedPrefix =
			firstLineBreak >= 0 ? value.slice(0, firstLineBreak) : value;
		const trailingText = firstLineBreak >= 0 ? value.slice(firstLineBreak) : "";
		const renderedPrefix = renderInsertedHtml(wrappedPrefix);
		const classAttr = paragraphClassAttr(indentClass);
		const wrappedFirstLine = `<p${classAttr}><ins class="${INSERTED_CLASS}">${renderedPrefix}</ins></p>`;
		if (trailingText.length === 0) {
			return wrappedFirstLine;
		}
		const renderedTrailing = renderInsertedHtml(trailingText);
		const wrappedTrailing = renderedTrailing.replace(
			/<p[^>]*>([\s\S]*?)<\/p>/g,
			`<p${classAttr}><ins class="${INSERTED_CLASS}">$1</ins></p>`,
		);
		return `${wrappedFirstLine}${wrappedTrailing}`;
	}
	if (startsWithMarker(value) && options?.allowMarkerStartWrap === false) {
		const rendered = renderInsertedHtml(value);
		if (!value.includes("\n")) {
			return `<ins class="${INSERTED_CLASS}">${rendered}</ins>`;
		}
		const classAttr = paragraphClassAttr(indentClass);
		return rendered.replace(
			/<p[^>]*>([\s\S]*?)<\/p>/g,
			`<p${classAttr}><ins class="${INSERTED_CLASS}">$1</ins></p>`,
		);
	}

	const rendered = renderInsertedHtml(value);
	const classAttr = paragraphClassAttr(indentClass);
	return rendered.replace(
		/<p>([\s\S]*?)<\/p>/g,
		`<p${classAttr}><ins class="${INSERTED_CLASS}">$1</ins></p>`,
	);
};

const renderDeletedHtml = (value: string): string => {
	if (!value.includes("\n")) {
		return escapeHtml(value);
	}
	const normalizedValue = value.includes("\n")
		? expandSingleLineBreaks(value)
		: value;
	const parsed = parseProcessor.parse(normalizedValue) as Root;
	addParagraphIndentClasses(parsed);
	unwrapBlockquotes(parsed);
	const hastTree = renderProcessor.runSync(parsed);
	return String(renderProcessor.stringify(hastTree));
};

const wrapDelHtml = (value: string, indentClass?: string): string => {
	if (!value.includes("\n")) {
		const rendered = renderDeletedHtml(value);
		return `<del class="${DELETED_CLASS}">${rendered}</del>`;
	}

	const rendered = renderDeletedHtml(value);
	const classAttr = paragraphClassAttr(indentClass);
	return rendered.replace(
		/<p[^>]*>([\s\S]*?)<\/p>/g,
		`<p${classAttr}><del class="${DELETED_CLASS}">$1</del></p>`,
	);
};

const getIndentClassFromParent = (
	parent: ParentWithChildren,
): string | null => {
	if (parent.type !== "paragraph") return null;
	const className = (
		parent as Node & { data?: { hProperties?: { className?: string[] } } }
	).data?.hProperties?.className;
	if (!Array.isArray(className)) return null;
	return className.find((name) => /^indent\d+$/.test(name)) ?? null;
};

const getOffset = (node: Node, key: "start" | "end"): number | undefined => {
	return (node as NodeWithPosition).position?.[key]?.offset;
};

const addParagraphIndentClasses = (tree: Root) => {
	const walk = (node: Node, blockquoteDepth: number) => {
		if (node.type === "paragraph") {
			const dataNode = node as Node & {
				data?: {
					hProperties?: { className?: string[] };
				};
			};
			const className = dataNode.data?.hProperties?.className ?? [];
			const filtered = className.filter((item) => !/^indent\d+$/.test(item));
			filtered.push(`indent${Math.min(blockquoteDepth, MAX_INDENT_DEPTH)}`);
			dataNode.data = {
				...(dataNode.data ?? {}),
				hProperties: {
					...(dataNode.data?.hProperties ?? {}),
					className: filtered,
				},
			};
		}

		if (!hasChildren(node)) {
			return;
		}

		const nextDepth = node.type === "blockquote" ? blockquoteDepth + 1 : 0;
		for (const child of node.children) {
			walk(child as Node, nextDepth);
		}
	};

	walk(tree as Node, 0);
};

const unwrapBlockquotes = (tree: Root) => {
	const unwrapInParent = (parent: ParentWithChildren) => {
		const nextChildren: RootContent[] = [];
		for (const child of parent.children) {
			const node = child as Node;
			if (node.type === "blockquote" && hasChildren(node)) {
				unwrapInParent(node);
				nextChildren.push(...node.children);
				continue;
			}
			if (hasChildren(node)) {
				unwrapInParent(node);
			}
			nextChildren.push(child);
		}
		parent.children = nextChildren;
	};

	unwrapInParent(tree as ParentWithChildren);
};

const hoistBlockHtmlOutOfParagraphs = (tree: Root) => {
	const hoistInParent = (parent: ParentWithChildren) => {
		const nextChildren: RootContent[] = [];
		for (const child of parent.children) {
			const node = child as Node;
			if (node.type === "paragraph" && hasChildren(node)) {
				const paragraph = node as ParentWithChildren;
				const allHtmlChildren = paragraph.children.every(
					(paragraphChild) => (paragraphChild as Node).type === "html",
				);
				if (allHtmlChildren) {
					const htmlContent = paragraph.children
						.map((paragraphChild) => {
							const htmlChild = paragraphChild as Node & { value?: string };
							return typeof htmlChild.value === "string" ? htmlChild.value : "";
						})
						.join("");
					if (/<p\b/i.test(htmlContent)) {
						nextChildren.push(htmlNode(htmlContent));
						continue;
					}
				}
			}
			if (hasChildren(node)) {
				hoistInParent(node as ParentWithChildren);
			}
			nextChildren.push(child);
		}
		parent.children = nextChildren;
	};

	hoistInParent(tree as ParentWithChildren);
};

const rewriteTreeLinks = (tree: Root, options: RenderMarkdownOptions) => {
	visit(tree as Node, "link", (node) => {
		const link = node as Node & { url?: string };
		if (typeof link.url !== "string") return;
		link.url = rewriteStatuteHref(link.url, options);
	});
};

const applyMarkdownReplacements = (
	tree: Root,
	source: string,
	ranges: MarkdownReplacementRange[],
) => {
	if (ranges.length === 0) return;

	const normalized = ranges
		.map((range, id) => ({
			...range,
			id,
			start: Math.max(0, Math.min(source.length, range.start)),
			end: Math.max(0, Math.min(source.length, range.end)),
		}))
		.filter((range) => range.end >= range.start)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	if (normalized.length === 0) return;

	const pointRanges = normalized.filter((range) => range.start === range.end);
	const segmentRanges = normalized.filter((range) => range.end > range.start);
	const touchedRangeIds = new Set<number>();
	const insertedDeletionIds = new Set<number>();
	const markerStartWrapConsumedIds = new Set<number>();
	const editsByParent = new Map<
		ParentWithChildren,
		Map<number, RootContent[]>
	>();

	visit(tree as Node, "text", (node, index, parent) => {
		if (typeof index !== "number") return;
		if (!parent || !hasChildren(parent as Node)) {
			return;
		}

		const start = getOffset(node as Node, "start");
		const end = getOffset(node as Node, "end");
		if (typeof start !== "number" || typeof end !== "number" || end < start) {
			return;
		}

		const overlaps = segmentRanges.filter(
			(range) => range.start < end && range.end > start,
		);
		const points = pointRanges.filter(
			(range) => range.start >= start && range.start <= end,
		);
		if (overlaps.length === 0 && points.length === 0) {
			return;
		}

		const boundaries = new Set<number>([start, end]);
		for (const range of overlaps) {
			boundaries.add(Math.max(start, range.start));
			boundaries.add(Math.min(end, range.end));
		}
		for (const point of points) {
			boundaries.add(point.start);
		}
		const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
		const pointByOffset = new Map<number, typeof pointRanges>();
		for (const point of points) {
			const existing = pointByOffset.get(point.start);
			if (existing) {
				existing.push(point);
				continue;
			}
			pointByOffset.set(point.start, [point]);
		}

		const nodeValue = (node as Node & { value: string }).value;
		const indentClass = getIndentClassFromParent(parent as ParentWithChildren);
		const replacementChildren: RootContent[] = [];

		for (let cursor = 0; cursor < sortedBoundaries.length; cursor += 1) {
			const segmentStart = sortedBoundaries[cursor];
			const segmentEnd = sortedBoundaries[cursor + 1];
			const pointInserts = pointByOffset.get(segmentStart) ?? [];
			for (const point of pointInserts) {
				if (point.deletedText.length === 0) continue;
				replacementChildren.push(
					htmlNode(wrapDelHtml(point.deletedText, indentClass ?? undefined)),
				);
				touchedRangeIds.add(point.id);
			}

			if (typeof segmentEnd !== "number" || segmentEnd <= segmentStart) {
				continue;
			}

			const relativeStart = segmentStart - start;
			const relativeEnd = segmentEnd - start;
			const segmentText = nodeValue.slice(relativeStart, relativeEnd);
			if (segmentText.length === 0) continue;

			const activeRange = overlaps.find(
				(range) => segmentStart < range.end && segmentEnd > range.start,
			);
			if (!activeRange) {
				replacementChildren.push(textNode(segmentText));
				continue;
			}

			if (
				activeRange.deletedText.length > 0 &&
				!insertedDeletionIds.has(activeRange.id)
			) {
				replacementChildren.push(
					htmlNode(
						wrapDelHtml(activeRange.deletedText, indentClass ?? undefined),
					),
				);
				insertedDeletionIds.add(activeRange.id);
			}

			const allowMarkerStartWrap =
				segmentStart === activeRange.start &&
				!markerStartWrapConsumedIds.has(activeRange.id);
			replacementChildren.push(
				htmlNode(
					wrapInsHtml(segmentText, indentClass ?? undefined, {
						allowMarkerStartWrap,
					}),
				),
			);
			if (allowMarkerStartWrap && startsWithMarker(segmentText)) {
				markerStartWrapConsumedIds.add(activeRange.id);
			}
			touchedRangeIds.add(activeRange.id);
		}

		const typedParent = parent as ParentWithChildren;
		const replacements = editsByParent.get(typedParent);
		if (!replacements) {
			editsByParent.set(typedParent, new Map([[index, replacementChildren]]));
			return;
		}
		replacements.set(index, replacementChildren);
	});

	for (const [parent, replacementMap] of editsByParent) {
		const sortedIndexes = Array.from(replacementMap.keys()).sort(
			(a, b) => b - a,
		);
		for (const index of sortedIndexes) {
			const replacementChildren = replacementMap.get(index);
			if (!replacementChildren) continue;
			parent.children.splice(index, 1, ...replacementChildren);
		}
	}

	for (const range of normalized) {
		if (touchedRangeIds.has(range.id)) continue;
		const fallbackChildren: RootContent[] = [];
		if (range.deletedText.length > 0) {
			fallbackChildren.push(htmlNode(wrapDelHtml(range.deletedText)));
		}
		if (range.end > range.start) {
			const insertedText = source.slice(range.start, range.end);
			if (insertedText.length > 0) {
				fallbackChildren.push(htmlNode(wrapInsHtml(insertedText)));
			}
		}
		if (fallbackChildren.length === 0) continue;
		tree.children.push(paragraphNode(fallbackChildren));
	}
};

export const renderMarkdown = (
	content: string,
	options: RenderMarkdownOptions = {},
): string => {
	const tree = parseProcessor.parse(content) as Root;
	rewriteTreeLinks(tree, options);
	addParagraphIndentClasses(tree);
	unwrapBlockquotes(tree);
	if (options.replacements && options.replacements.length > 0) {
		applyMarkdownReplacements(tree, content, options.replacements);
		hoistBlockHtmlOutOfParagraphs(tree);
	}
	const hastTree = renderProcessor.runSync(tree);
	return String(renderProcessor.stringify(hastTree));
};
