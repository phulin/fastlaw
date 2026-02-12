import { marked } from "marked";

type MarkdownToken = {
	type: string;
};

type BlockquoteToken = MarkdownToken & {
	tokens: MarkdownToken[];
};

const isBlockquoteToken = (token: MarkdownToken): token is BlockquoteToken =>
	token.type === "blockquote";

const MAX_INDENT_DEPTH = 5;

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

export const renderMarkdown = (content: string): string => {
	const tokens = marked.lexer(content) as MarkdownToken[];
	return renderTokensWithIndent(tokens, 0);
};
