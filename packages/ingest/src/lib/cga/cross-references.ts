type QualifierType =
	| "subsection"
	| "subdivision"
	| "paragraph"
	| "subparagraph"
	| "clause";

interface Qualifier {
	type: QualifierType;
	designators: string[];
}

type SectionMention = {
	section: string;
	offset: number;
	length: number;
};

type SectionTarget =
	| {
			type: "section";
			mention: SectionMention;
	  }
	| {
			type: "range";
			start: SectionMention;
			end: SectionMention;
			inclusive: boolean;
	  };

export interface SectionCrossReference {
	section: string;
	offset: number;
	length: number;
	link: string;
}

type Token =
	| { type: "sectionNumber"; value: string; start: number; end: number }
	| { type: "designator"; value: string }
	| { type: "word"; value: string }
	| { type: "punct"; value: "," | ";" | "." | ":" };

const SECTION_NUMBER_RE =
	/\b\d+[a-zA-Z]*-(?:\d+[a-zA-Z]*)(?:-\d+[a-zA-Z]*)*\b/i;
const DESIGNATOR_RE = /^\(([A-Za-z0-9ivxIVX]+)\)$/;
const TOKEN_RE =
	/\d+[a-zA-Z]*-(?:\d+[a-zA-Z]*)(?:-\d+[a-zA-Z]*)*|\([A-Za-z0-9ivxIVX]+\)|[A-Za-z]+(?:\/[A-Za-z]+)?|[,.;:]/g;

const QUALIFIER_KEYWORDS = new Map<string, QualifierType>([
	["subsection", "subsection"],
	["subsections", "subsection"],
	["subdivision", "subdivision"],
	["subdivisions", "subdivision"],
	["paragraph", "paragraph"],
	["paragraphs", "paragraph"],
	["subparagraph", "subparagraph"],
	["subparagraphs", "subparagraph"],
	["clause", "clause"],
	["clauses", "clause"],
]);

const SECTION_KEYWORDS = new Set(["section", "sections", "sec", "secs"]);
const SEPARATOR_WORDS = new Set(["and", "or", "and/or"]);

export function extractSectionCrossReferences(
	text: string,
): SectionCrossReference[] {
	const tokens = tokenize(text);
	const references: SectionCrossReference[] = [];

	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (!token) {
			index += 1;
			continue;
		}

		if (isQualifierKeyword(token) || isSectionKeyword(token)) {
			const parsed = parseReference(tokens, index);
			if (parsed) {
				references.push(...parsed.references);
				index = parsed.nextIndex;
				continue;
			}
		}

		if (isSectionNumber(token)) {
			const sectionList = parseSectionList(tokens, index, true);
			if (sectionList) {
				references.push(...buildReferences(sectionList.items));
				index = sectionList.nextIndex;
				continue;
			}
		}
		index += 1;
	}

	return dedupeReferences(references);
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const matches = text.matchAll(TOKEN_RE);

	for (const match of matches) {
		const raw = match[0];
		if (!raw) continue;

		if (SECTION_NUMBER_RE.test(raw)) {
			const start = match.index ?? 0;
			const end = start + raw.length;
			tokens.push({
				type: "sectionNumber",
				value: normalizeSectionNumber(raw),
				start,
				end,
			});
			continue;
		}

		const designatorMatch = raw.match(DESIGNATOR_RE);
		if (designatorMatch) {
			tokens.push({ type: "designator", value: designatorMatch[1] });
			continue;
		}

		if (raw === "," || raw === ";" || raw === "." || raw === ":") {
			tokens.push({ type: "punct", value: raw });
			continue;
		}

		tokens.push({ type: "word", value: raw.toLowerCase() });
	}

	return tokens;
}

function normalizeSectionNumber(value: string): string {
	return value.toLowerCase();
}

function isQualifierKeyword(
	token: Token,
): token is { type: "word"; value: string } {
	return token.type === "word" && QUALIFIER_KEYWORDS.has(token.value);
}

function isSectionKeyword(
	token: Token,
): token is { type: "word"; value: string } {
	return token.type === "word" && SECTION_KEYWORDS.has(token.value);
}

function isWord(token: Token | undefined, value: string): boolean {
	return token?.type === "word" && token.value === value;
}

function isDesignator(
	token: Token | undefined,
): token is { type: "designator"; value: string } {
	return token?.type === "designator";
}

function isSectionNumber(token: Token | undefined): token is {
	type: "sectionNumber";
	value: string;
	start: number;
	end: number;
} {
	return token?.type === "sectionNumber";
}

function isSeparator(token: Token | undefined): boolean {
	if (!token) return false;
	if (token.type === "punct") {
		return token.value === "," || token.value === ";";
	}
	return token.type === "word" && SEPARATOR_WORDS.has(token.value);
}

function parseReference(
	tokens: Token[],
	startIndex: number,
): { references: SectionCrossReference[]; nextIndex: number } | null {
	const token = tokens[startIndex];
	if (!token) return null;

	if (isQualifierKeyword(token)) {
		const qualifierChains = parseQualifierChainList(tokens, startIndex);
		if (!qualifierChains) return null;

		let index = qualifierChains.nextIndex;
		if (!isWord(tokens[index], "of")) return null;
		index += 1;

		const sectionKeyword = tokens[index];
		if (!sectionKeyword || !isSectionKeyword(sectionKeyword)) return null;

		const allowMultiple =
			sectionKeyword.value === "sections" || sectionKeyword.value === "secs";
		const sectionList = parseSectionList(tokens, index + 1, allowMultiple);
		if (!sectionList) return null;

		const references = buildReferences(sectionList.items);
		return { references, nextIndex: sectionList.nextIndex };
	}

	if (isSectionKeyword(token)) {
		const sectionList = parseSectionList(tokens, startIndex + 1, true);
		if (!sectionList) return null;
		const references = buildReferences(sectionList.items);
		return { references, nextIndex: sectionList.nextIndex };
	}

	return null;
}

function parseQualifierChainList(
	tokens: Token[],
	startIndex: number,
): { chains: Qualifier[][]; nextIndex: number } | null {
	const firstChain = parseQualifierChain(tokens, startIndex);
	if (!firstChain) return null;

	const chains: Qualifier[][] = [firstChain.qualifiers];
	let index = firstChain.nextIndex;

	while (true) {
		const separatorIndex = consumeSeparators(tokens, index);
		if (separatorIndex === null) break;

		const nextToken = tokens[separatorIndex];
		if (!nextToken || !isQualifierKeyword(nextToken)) {
			break;
		}

		const nextChain = parseQualifierChain(tokens, separatorIndex);
		if (!nextChain) break;

		chains.push(nextChain.qualifiers);
		index = nextChain.nextIndex;
	}

	return { chains, nextIndex: index };
}

function parseQualifierChain(
	tokens: Token[],
	startIndex: number,
): { qualifiers: Qualifier[]; nextIndex: number } | null {
	const qualifier = parseQualifier(tokens, startIndex);
	if (!qualifier) return null;

	const qualifiers: Qualifier[] = [qualifier.qualifier];
	let index = qualifier.nextIndex;

	while (isWord(tokens[index], "of")) {
		const nextToken = tokens[index + 1];
		if (!nextToken || !isQualifierKeyword(nextToken)) break;

		const nextQualifier = parseQualifier(tokens, index + 1);
		if (!nextQualifier) break;

		qualifiers.push(nextQualifier.qualifier);
		index = nextQualifier.nextIndex;
	}

	return { qualifiers, nextIndex: index };
}

function parseQualifier(
	tokens: Token[],
	startIndex: number,
): { qualifier: Qualifier; nextIndex: number } | null {
	const token = tokens[startIndex];
	if (!token || !isQualifierKeyword(token)) return null;

	const type = QUALIFIER_KEYWORDS.get(token.value);
	if (!type) return null;

	const list = parseDesignatorList(tokens, startIndex + 1);
	if (!list) return null;

	return {
		qualifier: { type, designators: list.designators },
		nextIndex: list.nextIndex,
	};
}

function parseDesignatorList(
	tokens: Token[],
	startIndex: number,
): { designators: string[]; nextIndex: number } | null {
	const first = tokens[startIndex];
	if (!isDesignator(first)) return null;

	const designators: string[] = [first.value];
	let index = startIndex + 1;

	while (true) {
		const sepIndex = consumeSeparators(tokens, index);
		if (sepIndex === null) break;

		const nextToken = tokens[sepIndex];
		if (!isDesignator(nextToken)) break;

		designators.push(nextToken.value);
		index = sepIndex + 1;
	}

	return { designators, nextIndex: index };
}

function parseSectionList(
	tokens: Token[],
	startIndex: number,
	allowMultiple: boolean,
): { items: SectionTarget[]; nextIndex: number } | null {
	const firstItem = parseSectionItem(tokens, startIndex);
	if (!firstItem) return null;

	const items: SectionTarget[] = [firstItem.item];
	let index = firstItem.nextIndex;

	if (!allowMultiple) {
		return { items, nextIndex: index };
	}

	while (true) {
		const sepIndex = consumeSeparators(tokens, index);
		if (sepIndex === null) break;

		let nextIndex = sepIndex;
		if (isSectionKeyword(tokens[nextIndex])) {
			nextIndex += 1;
		}

		const nextItem = parseSectionItem(tokens, nextIndex);
		if (!nextItem) break;

		items.push(nextItem.item);
		index = nextItem.nextIndex;
	}

	return { items, nextIndex: index };
}

function parseSectionItem(
	tokens: Token[],
	startIndex: number,
): { item: SectionTarget; nextIndex: number } | null {
	const token = tokens[startIndex];
	if (!isSectionNumber(token)) return null;

	let index = startIndex + 1;
	const startMention = {
		section: token.value,
		offset: token.start,
		length: token.end - token.start,
	};

	if (isWord(tokens[index], "to")) {
		const endToken = tokens[index + 1];
		if (!isSectionNumber(endToken)) return null;

		index += 2;
		let inclusive = false;

		if (tokens[index]?.type === "punct" && tokens[index]?.value === ",") {
			if (isWord(tokens[index + 1], "inclusive")) {
				inclusive = true;
				index += 2;
			}
		} else if (isWord(tokens[index], "inclusive")) {
			inclusive = true;
			index += 1;
		}

		const endMention = {
			section: endToken.value,
			offset: endToken.start,
			length: endToken.end - endToken.start,
		};

		return {
			item: { type: "range", start: startMention, end: endMention, inclusive },
			nextIndex: index,
		};
	}

	return { item: { type: "section", mention: startMention }, nextIndex: index };
}

function consumeSeparators(tokens: Token[], startIndex: number): number | null {
	let index = startIndex;
	let consumed = false;

	while (isSeparator(tokens[index])) {
		consumed = true;
		index += 1;
	}

	return consumed ? index : null;
}

function buildReferences(items: SectionTarget[]): SectionCrossReference[] {
	const refs: SectionCrossReference[] = [];

	for (const item of items) {
		if (item.type === "section") {
			refs.push(buildReference(item.mention));
			continue;
		}

		refs.push(buildReference(item.start), buildReference(item.end));
	}

	return refs;
}

function dedupeReferences(
	references: SectionCrossReference[],
): SectionCrossReference[] {
	const seen = new Set<string>();
	const result: SectionCrossReference[] = [];

	for (const ref of references) {
		const key = `${ref.section}:${ref.offset}:${ref.length}:${ref.link}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(ref);
	}

	return result;
}

function buildReference(mention: SectionMention): SectionCrossReference {
	return {
		section: mention.section,
		offset: mention.offset,
		length: mention.length,
		link: buildSectionLink(mention.section),
	};
}

function buildSectionLink(section: string): string {
	return `/statutes/cgs/section/${section}`;
}
