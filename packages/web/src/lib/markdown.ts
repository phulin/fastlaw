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

type HtmlToken = MarkdownToken & {
	type: "html";
	text: string;
};

const isHtmlToken = (token: MarkdownToken): token is HtmlToken =>
	token.type === "html" && typeof token.text === "string";

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

const addIndentClassToParagraphs = (
	html: string,
	blockquoteDepth: number,
): string => {
	const indentClass = `indent${Math.min(blockquoteDepth, MAX_INDENT_DEPTH)}`;
	const upsertClass = (attrs: string): string => {
		const classMatch = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/);
		if (!classMatch) {
			return `${attrs} class="${indentClass}"`;
		}

		const existingClasses = classMatch[2]
			.split(/\s+/)
			.filter((value) => value.length > 0);
		if (!existingClasses.includes(indentClass)) {
			existingClasses.push(indentClass);
		}

		const quote = classMatch[1];
		const replacement = `class=${quote}${existingClasses.join(" ")}${quote}`;
		return attrs.replace(classMatch[0], replacement);
	};

	return html.replace(
		/<p\b([^>]*)>([\s\S]*?)<\/p>/g,
		(_fullMatch, attrs: string, body: string) => {
			const attrsWithIndent = upsertClass(attrs);
			if (blockquoteDepth <= 0 || !body.includes("\n")) {
				return `<p${attrsWithIndent}>${body}</p>`;
			}

			const lines = body
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			if (lines.length <= 1) {
				return `<p${attrsWithIndent}>${body}</p>`;
			}

			return lines.map((line) => `<p${attrsWithIndent}>${line}</p>`).join("");
		},
	);
};

const renderQuotedInsBlock = (
	htmlTokenText: string,
	blockquoteDepth: number,
	options: RenderMarkdownOptions,
): string | null => {
	const insMatch = htmlTokenText.match(
		/^<ins\b([^>]*)>\s*\n([\s\S]*?)\n\s*<\/ins>\s*$/,
	);
	if (!insMatch) return null;

	const insBody = insMatch[2];
	if (!insBody || !/^\s*>/m.test(insBody)) return null;
	const insAttributes = insMatch[1] ?? "";
	const renderedBody = renderTokenizedMarkdown(
		insBody,
		options,
		blockquoteDepth,
	);
	return `<ins${insAttributes}>${renderedBody}</ins>`;
};

const renderTokensWithIndent = (
	tokens: MarkdownToken[],
	blockquoteDepth: number,
	options: RenderMarkdownOptions,
): string => {
	const parts: string[] = [];
	const passthrough: MarkdownToken[] = [];

	const flushPassthrough = () => {
		if (passthrough.length === 0) {
			return;
		}

		const parsed = marked.parser([...passthrough] as never);
		parts.push(addIndentClassToParagraphs(parsed, blockquoteDepth));
		passthrough.length = 0;
	};

	for (const token of tokens) {
		if (isHtmlToken(token)) {
			const renderedInsBlock = renderQuotedInsBlock(
				token.text,
				blockquoteDepth,
				options,
			);
			if (renderedInsBlock) {
				flushPassthrough();
				parts.push(renderedInsBlock);
				continue;
			}
		}

		if (!isBlockquoteToken(token)) {
			passthrough.push(token);
			continue;
		}

		flushPassthrough();

		parts.push(
			renderTokensWithIndent(token.tokens, blockquoteDepth + 1, options),
		);
	}

	flushPassthrough();

	return parts.join("");
};

const renderTokenizedMarkdown = (
	content: string,
	options: RenderMarkdownOptions,
	blockquoteDepth = 0,
): string => {
	const tokens = marked.lexer(content) as MarkdownToken[];
	rewriteTokenLinks(tokens, options);
	return renderTokensWithIndent(tokens, blockquoteDepth, options);
};

export const renderMarkdown = (
	content: string,
	options: RenderMarkdownOptions = {},
): string => {
	return renderTokenizedMarkdown(content, options);
};
