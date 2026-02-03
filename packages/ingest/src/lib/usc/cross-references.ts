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
	titleNum: string | null;
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
	titleNum: string | null;
	offset: number;
	length: number;
	link: string | null;
}

type Token =
	| {
			type: "sectionNumber";
			value: string;
			titleNum: string | null;
			start: number;
			end: number;
	  }
	| { type: "titleNumber"; value: string; start: number; end: number }
	| { type: "designator"; value: string }
	| { type: "word"; value: string }
	| { type: "punct"; value: "," | ";" | "." | ":" };

// USC section numbers are simpler: digits with optional letter suffix (e.g., "1234", "1234a", "5")
const SECTION_NUMBER_RE = /^\d+[a-zA-Z]*(?:-\d+)?$/;
// Title number reference
const TITLE_NUMBER_RE = /^\d+$/;
const DESIGNATOR_RE = /^\(([A-Za-z0-9ivxIVX]+)\)$/;
// Token regex: matches section numbers, designators, words (including U.S.C.), and punctuation
const TOKEN_RE =
	/\d+[a-zA-Z]*(?:-\d+)?|\([A-Za-z0-9ivxIVX]+\)|U\.?S\.?C\.?|[A-Za-z]+(?:\/[A-Za-z]+)?|[,.;:§]/g;

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
const TITLE_KEYWORDS = new Set(["title"]);
const USC_KEYWORDS = new Set(["usc", "u.s.c.", "u.s.c"]);
const SEPARATOR_WORDS = new Set(["and", "or", "and/or"]);

/**
 * Extract cross-references from USC section text.
 * @param text The section body text
 * @param currentTitleNum The title number of the current section (for relative references)
 */
export function extractSectionCrossReferences(
	text: string,
	currentTitleNum: string,
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

		// Check for "42 U.S.C. 1234" style references
		if (token.type === "titleNumber") {
			const parsed = parseTitleUSCReference(tokens, index);
			if (parsed) {
				references.push(...parsed.references);
				index = parsed.nextIndex;
				continue;
			}
		}

		// Check for "section 1234" or "section 1234 of title 42" style references
		if (isQualifierKeyword(token) || isSectionKeyword(token)) {
			const parsed = parseReference(tokens, index, currentTitleNum);
			if (parsed) {
				references.push(...parsed.references);
				index = parsed.nextIndex;
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

		const start = match.index ?? 0;
		const end = start + raw.length;

		// Check for section symbol
		if (raw === "§") {
			tokens.push({ type: "word", value: "section" });
			continue;
		}

		// Check for U.S.C. pattern
		if (USC_KEYWORDS.has(raw.toLowerCase().replace(/\./g, ""))) {
			tokens.push({ type: "word", value: "usc" });
			continue;
		}

		// Check if it's a number (could be title or section number)
		if (TITLE_NUMBER_RE.test(raw)) {
			tokens.push({
				type: "titleNumber",
				value: raw,
				start,
				end,
			});
			continue;
		}

		// Check for section number with letter suffix
		if (SECTION_NUMBER_RE.test(raw)) {
			tokens.push({
				type: "sectionNumber",
				value: normalizeSectionNumber(raw),
				titleNum: null,
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
	token: Token | undefined,
): token is { type: "word"; value: string } {
	return token?.type === "word" && QUALIFIER_KEYWORDS.has(token.value);
}

function isSectionKeyword(
	token: Token | undefined,
): token is { type: "word"; value: string } {
	return token?.type === "word" && SECTION_KEYWORDS.has(token.value);
}

function isTitleKeyword(
	token: Token | undefined,
): token is { type: "word"; value: string } {
	return token?.type === "word" && TITLE_KEYWORDS.has(token.value);
}

function isUSCKeyword(
	token: Token | undefined,
): token is { type: "word"; value: string } {
	return token?.type === "word" && token.value === "usc";
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
	titleNum: string | null;
	start: number;
	end: number;
} {
	return token?.type === "sectionNumber";
}

function isTitleNumber(token: Token | undefined): token is {
	type: "titleNumber";
	value: string;
	start: number;
	end: number;
} {
	return token?.type === "titleNumber";
}

function isSeparator(token: Token | undefined): boolean {
	if (!token) return false;
	if (token.type === "punct") {
		return token.value === "," || token.value === ";";
	}
	return token.type === "word" && SEPARATOR_WORDS.has(token.value);
}

/**
 * Parse "42 U.S.C. 1234" style references
 */
function parseTitleUSCReference(
	tokens: Token[],
	startIndex: number,
): { references: SectionCrossReference[]; nextIndex: number } | null {
	const titleToken = tokens[startIndex];
	if (!isTitleNumber(titleToken)) return null;

	const uscToken = tokens[startIndex + 1];
	if (!uscToken || !isUSCKeyword(uscToken)) return null;

	// Now expect section number(s)
	const sectionList = parseSectionList(
		tokens,
		startIndex + 2,
		true,
		titleToken.value,
	);
	if (!sectionList) return null;

	const references = buildReferences(sectionList.items);
	return { references, nextIndex: sectionList.nextIndex };
}

function parseReference(
	tokens: Token[],
	startIndex: number,
	currentTitleNum: string,
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
		const sectionList = parseSectionListWithTitle(
			tokens,
			index + 1,
			allowMultiple,
			currentTitleNum,
		);
		if (!sectionList) return null;

		const references = buildReferences(sectionList.items);
		return { references, nextIndex: sectionList.nextIndex };
	}

	if (isSectionKeyword(token)) {
		const sectionList = parseSectionListWithTitle(
			tokens,
			startIndex + 1,
			true,
			currentTitleNum,
		);
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

/**
 * Parse section list, looking for optional "of title X" at the end
 */
function parseSectionListWithTitle(
	tokens: Token[],
	startIndex: number,
	allowMultiple: boolean,
	defaultTitleNum: string,
): { items: SectionTarget[]; nextIndex: number } | null {
	const sectionList = parseSectionList(
		tokens,
		startIndex,
		allowMultiple,
		defaultTitleNum,
	);
	if (!sectionList) return null;

	let index = sectionList.nextIndex;
	let titleNum = defaultTitleNum;

	// Check for "of title X" pattern
	if (isWord(tokens[index], "of") && isTitleKeyword(tokens[index + 1])) {
		const titleNumToken = tokens[index + 2];
		if (isTitleNumber(titleNumToken)) {
			titleNum = titleNumToken.value;
			index = index + 3;

			// Update all items with the explicit title number
			for (const item of sectionList.items) {
				if (item.type === "section") {
					item.mention.titleNum = titleNum;
				} else {
					item.start.titleNum = titleNum;
					item.end.titleNum = titleNum;
				}
			}
		}
	}

	return { items: sectionList.items, nextIndex: index };
}

function parseSectionList(
	tokens: Token[],
	startIndex: number,
	allowMultiple: boolean,
	defaultTitleNum: string | null,
): { items: SectionTarget[]; nextIndex: number } | null {
	const firstItem = parseSectionItem(tokens, startIndex, defaultTitleNum);
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

		const nextItem = parseSectionItem(tokens, nextIndex, defaultTitleNum);
		if (!nextItem) break;

		items.push(nextItem.item);
		index = nextItem.nextIndex;
	}

	return { items, nextIndex: index };
}

function parseSectionItem(
	tokens: Token[],
	startIndex: number,
	defaultTitleNum: string | null,
): { item: SectionTarget; nextIndex: number } | null {
	let token = tokens[startIndex];

	// Handle case where titleNumber could actually be a section number
	if (isTitleNumber(token)) {
		token = {
			type: "sectionNumber",
			value: token.value,
			titleNum: defaultTitleNum,
			start: token.start,
			end: token.end,
		};
	}

	if (!isSectionNumber(token)) return null;

	let index = startIndex + 1;
	const startMention: SectionMention = {
		section: token.value,
		titleNum: token.titleNum ?? defaultTitleNum,
		offset: token.start,
		length: token.end - token.start,
	};

	if (isWord(tokens[index], "to") || isWord(tokens[index], "through")) {
		let endToken = tokens[index + 1];

		// Handle titleNumber as sectionNumber
		if (isTitleNumber(endToken)) {
			endToken = {
				type: "sectionNumber",
				value: endToken.value,
				titleNum: defaultTitleNum,
				start: endToken.start,
				end: endToken.end,
			};
		}

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

		const endMention: SectionMention = {
			section: endToken.value,
			titleNum: endToken.titleNum ?? defaultTitleNum,
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
		const key = `${ref.section}:${ref.titleNum}:${ref.offset}:${ref.length}:${ref.link}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(ref);
	}

	return result;
}

function buildReference(mention: SectionMention): SectionCrossReference {
	return {
		section: mention.section,
		titleNum: mention.titleNum,
		offset: mention.offset,
		length: mention.length,
		link: buildSectionLink(mention.section, mention.titleNum),
	};
}

function buildSectionLink(
	section: string,
	titleNum: string | null,
): string | null {
	if (!titleNum) return null;
	return `/statutes/usc/section/${titleNum}/${section}`;
}
