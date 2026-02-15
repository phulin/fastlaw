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
const INSERTED_CLASS = "pdf-amended-snippet-inserted";
const DELETED_CLASS = "pdf-amended-snippet-deleted";

marked.use({
	extensions: [
		{
			name: "delBlock",
			level: "block",
			start(src: string) {
				return src.indexOf("~~\n");
			},
			tokenizer(src: string) {
				const canonicalMatch = /^~~\n([\s\S]+?)\n~~(?:\n|$)/.exec(src);
				if (canonicalMatch) {
					return {
						type: "delBlock",
						raw: canonicalMatch[0],
						text: canonicalMatch[1] ?? "",
					};
				}
				const fallbackMatch = /^~~\n([\s\S]+?)~~(?:\n|$)/.exec(src);
				if (!fallbackMatch) return undefined;
				return {
					type: "delBlock",
					raw: fallbackMatch[0],
					text: fallbackMatch[1] ?? "",
				};
			},
			renderer(token: unknown) {
				const text =
					typeof token === "object" &&
					token !== null &&
					"text" in token &&
					typeof token.text === "string"
						? token.text
						: "";
				return `<del class="${DELETED_CLASS}">${renderTokenizedMarkdown(text, {}, 0)}</del>`;
			},
		},
		{
			name: "insBlock",
			level: "block",
			start(src: string) {
				return src.indexOf("++\n");
			},
			tokenizer(src: string) {
				const match = /^\+\+\n([\s\S]+?)\n\+\+(?:\n|$)/.exec(src);
				if (!match) return undefined;
				return {
					type: "insBlock",
					raw: match[0],
					text: match[1] ?? "",
				};
			},
			renderer(token: unknown) {
				const text =
					typeof token === "object" &&
					token !== null &&
					"text" in token &&
					typeof token.text === "string"
						? token.text
						: "";
				return `<ins class="${INSERTED_CLASS}">${renderTokenizedMarkdown(text, {}, 0)}</ins>`;
			},
		},
		{
			name: "del",
			level: "inline",
			start(src: string) {
				return src.indexOf("~~");
			},
			tokenizer(this: { lexer: typeof marked.Lexer.prototype }, src: string) {
				const match = /^~~([^\n]+?)~~/.exec(src);
				if (!match) return undefined;
				const text = match[1] ?? "";
				return {
					type: "del",
					raw: match[0],
					text,
					tokens: this.lexer.inlineTokens(text),
				};
			},
			renderer(
				this: { parser: typeof marked.Parser.prototype },
				token: unknown,
			) {
				const tokens =
					typeof token === "object" &&
					token !== null &&
					"tokens" in token &&
					Array.isArray(token.tokens)
						? (token.tokens as never)
						: [];
				return `<del class="${DELETED_CLASS}">${this.parser.parseInline(tokens)}</del>`;
			},
		},
		{
			name: "ins",
			level: "inline",
			start(src: string) {
				return src.indexOf("++");
			},
			tokenizer(this: { lexer: typeof marked.Lexer.prototype }, src: string) {
				const match = /^\+\+([\s\S]+?)\+\+/.exec(src);
				if (!match) return undefined;
				const text = match[1] ?? "";
				return {
					type: "ins",
					raw: match[0],
					text,
					tokens: this.lexer.inlineTokens(text),
				};
			},
			renderer(
				this: { parser: typeof marked.Parser.prototype },
				token: unknown,
			) {
				const tokens =
					typeof token === "object" &&
					token !== null &&
					"tokens" in token &&
					Array.isArray(token.tokens)
						? (token.tokens as never)
						: [];
				return `<ins class="${INSERTED_CLASS}">${this.parser.parseInline(tokens)}</ins>`;
			},
		},
	],
});

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
	return html.replace(
		/<p\b([^>]*)>([\s\S]*?)<\/p>/g,
		(_fullMatch, attrs: string, body: string) => {
			const classMatch = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/);
			const quote = classMatch?.[1] ?? '"';
			const existingClasses = classMatch
				? classMatch[2].split(/\s+/).filter((v) => v.length > 0)
				: [];

			let foundIndent = false;
			const newClasses = existingClasses.map((cls) => {
				const match = cls.match(/^indent(\d+)$/);
				if (match) {
					foundIndent = true;
					const depth =
						Number.parseInt(match[1], 10) +
						Math.min(blockquoteDepth, MAX_INDENT_DEPTH);
					return `indent${Math.min(depth, MAX_INDENT_DEPTH)}`;
				}
				return cls;
			});

			if (!foundIndent) {
				newClasses.push(`indent${Math.min(blockquoteDepth, MAX_INDENT_DEPTH)}`);
			}

			const replacement = `class=${quote}${newClasses.join(" ")}${quote}`;
			const newAttrs = classMatch
				? attrs.replace(classMatch[0], replacement)
				: `${attrs} ${replacement}`;

			if (blockquoteDepth <= 0 || !body.includes("\n")) {
				return `<p${newAttrs}>${body}</p>`;
			}

			const lines = body
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			if (lines.length <= 1) {
				return `<p${newAttrs}>${body}</p>`;
			}

			return lines.map((line) => `<p${newAttrs}>${line}</p>`).join("");
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
