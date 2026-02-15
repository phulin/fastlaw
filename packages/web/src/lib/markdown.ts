import { marked } from "marked";

type MarkdownToken = {
	type: string;
	href?: string;
	tokens?: MarkdownToken[];
	items?: MarkdownToken[];
	[key: string]: unknown;
};

type BlockquoteToken = MarkdownToken & {
	tokens: MarkdownToken[];
};

const isBlockquoteToken = (token: MarkdownToken): token is BlockquoteToken =>
	token.type === "blockquote";

const MAX_INDENT_DEPTH = 5;

type RenderMarkdownOptions = {
	statuteRoutePrefix?: string;
	sourceCode?: string;
};

const STATUTES_PREFIX = "/statutes/";

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

const rewriteTokenLinks = (
	tokens: MarkdownToken[],
	options: RenderMarkdownOptions,
) => {
	for (const token of tokens) {
		if (token.type === "link" && typeof token.href === "string") {
			token.href = rewriteStatuteHref(token.href, options);
		}

		if (Array.isArray(token.tokens)) {
			rewriteTokenLinks(token.tokens, options);
		}
		if (Array.isArray(token.items)) {
			rewriteTokenLinks(token.items, options);
		}
	}
};

const renderTokensWithIndent = (
	tokens: MarkdownToken[],
	blockquoteDepth: number,
): string => {
	const parts: string[] = [];
	const passthrough: MarkdownToken[] = [];

	const flushPassthrough = () => {
		if (passthrough.length === 0) {
			return;
		}

		parts.push(marked.parser([...passthrough] as never));
		passthrough.length = 0;
	};

	for (const token of tokens) {
		if (!isBlockquoteToken(token)) {
			passthrough.push(token);
			continue;
		}

		flushPassthrough();

		const indentDepth = Math.min(blockquoteDepth + 1, MAX_INDENT_DEPTH);
		const inner = renderTokensWithIndent(token.tokens, indentDepth);
		parts.push(`<div class="indent${indentDepth}">${inner}</div>`);
	}

	flushPassthrough();

	return parts.join("");
};

export const renderMarkdown = (
	content: string,
	options: RenderMarkdownOptions = {},
): string => {
	const tokens = marked.lexer(content) as MarkdownToken[];
	rewriteTokenLinks(tokens, options);
	return renderTokensWithIndent(tokens, 0);
};
