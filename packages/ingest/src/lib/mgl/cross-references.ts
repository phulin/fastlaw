export interface SectionCrossReference {
	section: string;
	chapter: string;
	offset: number;
	length: number;
	link: string;
}

const CHAPTER_SECTION_RE =
	/\bchapter\s+(\d+[a-zA-Z]?)\s*,\s*section\s+(\d+[a-zA-Z]?)\b/gi;
const OF_CHAPTER_RE =
	/\bsection\s+(\d+[a-zA-Z]?)\s+of\s+chapter\s+(\d+[a-zA-Z]?)\b/gi;

function normalizeDesignator(value: string): string {
	return value.trim().toUpperCase();
}

function makeLink(chapter: string, section: string): string {
	return `/statutes/mgl/chapter/${chapter.toLowerCase()}/section/${section.toLowerCase()}`;
}

function collectMatches(
	text: string,
	regex: RegExp,
	map: (match: RegExpMatchArray) => { chapter: string; section: string } | null,
): SectionCrossReference[] {
	const refs: SectionCrossReference[] = [];
	for (const match of text.matchAll(regex)) {
		const full = match[0];
		if (!full || match.index === undefined) {
			continue;
		}
		const mapped = map(match);
		if (!mapped) continue;
		const chapterRaw = mapped.chapter;
		const sectionRaw = mapped.section;
		const chapter = normalizeDesignator(chapterRaw);
		const section = normalizeDesignator(sectionRaw);
		refs.push({
			chapter,
			section,
			offset: match.index,
			length: full.length,
			link: makeLink(chapter, section),
		});
	}
	return refs;
}

export function extractSectionCrossReferences(
	text: string,
): SectionCrossReference[] {
	const refs = [
		...collectMatches(text, CHAPTER_SECTION_RE, (match) => {
			const chapter = match[1];
			const section = match[2];
			if (!chapter || !section) return null;
			return { chapter, section };
		}),
		...collectMatches(text, OF_CHAPTER_RE, (match) => {
			const section = match[1];
			const chapter = match[2];
			if (!chapter || !section) return null;
			return { chapter, section };
		}),
	];

	const unique = new Map<string, SectionCrossReference>();
	for (const ref of refs) {
		const key = `${ref.chapter}:${ref.section}:${ref.offset}`;
		if (!unique.has(key)) unique.set(key, ref);
	}

	return [...unique.values()].sort((a, b) => a.offset - b.offset);
}
