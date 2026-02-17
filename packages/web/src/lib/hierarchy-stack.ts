export enum LevelType {
	Section = 0,
	Subsection = 1,
	Paragraph = 2,
	Subparagraph = 3,
	Clause = 4,
	Subclause = 5,
	Item = 6,
	Subitem = 7,
}

function tokenRankForLevel(level: LevelType, token: string): number {
	if (level === LevelType.Section || level === LevelType.Paragraph) {
		return Number(token);
	}
	if (level === LevelType.Subsection || level === LevelType.Subparagraph) {
		return alphaToInt(token);
	}
	if (level === LevelType.Clause || level === LevelType.Subclause) {
		return romanToInt(token);
	}
	if (level === LevelType.Item || level === LevelType.Subitem) {
		if (token[0] === token[1]) return token.charCodeAt(0);
		return alphaToInt(token);
	}
	return Number.NaN;
}

function isTokenShapeForLevel(level: LevelType, token: string): boolean {
	if (level === LevelType.Section || level === LevelType.Paragraph) {
		return /^\d+$/.test(token);
	}
	if (level === LevelType.Subsection) {
		return /^[a-z]$/.test(token);
	}
	if (level === LevelType.Subparagraph) {
		return /^[A-Z]$/.test(token);
	}
	if (level === LevelType.Clause) {
		return /^[ivxlcdm]+$/.test(token);
	}
	if (level === LevelType.Subclause) {
		return /^[IVXLCDM]+$/.test(token);
	}
	if (level === LevelType.Item) {
		return /^[a-z]{2}$/.test(token);
	}
	if (level === LevelType.Subitem) {
		return /^[A-Z]{2}$/.test(token);
	}
	return false;
}

function defaultLevelForToken(token: string): LevelType {
	if (/^[a-z]$/.test(token)) return LevelType.Subsection;
	if (/^\d+$/.test(token)) return LevelType.Paragraph;
	if (/^[A-Z]$/.test(token)) return LevelType.Subparagraph;
	if (/^[ivxlcdm]+$/.test(token)) return LevelType.Clause;
	if (/^[IVXLCDM]+$/.test(token)) return LevelType.Subclause;
	if (/^[a-z]{2}$/.test(token)) return LevelType.Item;
	return LevelType.Subitem;
}

export class HierarchyEntry {
	readonly rank: number;

	private constructor(
		readonly level: LevelType,
		readonly token: string,
	) {
		this.rank = tokenRankForLevel(level, token);
	}

	static make(level: LevelType, token: string) {
		const result = new HierarchyEntry(level, token);
		if (!isTokenShapeForLevel(level, token) || !Number.isFinite(result.rank)) {
			return null;
		}
		return result;
	}

	static sectionDummy() {
		return new HierarchyEntry(LevelType.Section, "1");
	}
}

export type HierarchyContinuationRelation = "ascend" | "sibling" | "descend";

interface HierarchyPenaltyContext {
	largeIndentDecrease: boolean;
}

function romanToInt(input: string): number {
	const map: Record<string, number> = {
		I: 1,
		V: 5,
		X: 10,
		L: 50,
		C: 100,
		D: 500,
		M: 1000,
	};
	const s = input.toUpperCase();
	let value = 0;
	for (let i = 0; i < s.length; i++) {
		const current = map[s[i]];
		const next = map[s[i + 1]];
		value += next && current < next ? -current : current;
	}
	return value;
}

function alphaToInt(input: string): number {
	if (input.length === 1) {
		return input.toLowerCase().charCodeAt(0) - 96;
	}
	if (input.length === 2) {
		return (
			(input.toLowerCase().charCodeAt(0) - 96) * 26 +
			(input.toLowerCase().charCodeAt(1) - 96)
		);
	}
	return Number.NaN;
}

function isValidSiblingProgression(
	previous: HierarchyEntry,
	current: HierarchyEntry,
): boolean {
	if (previous.level !== current.level) return false;
	if (
		!isTokenShapeForLevel(previous.level, previous.token) ||
		!isTokenShapeForLevel(current.level, current.token)
	) {
		return false;
	}
	if (!Number.isFinite(previous.rank) || !Number.isFinite(current.rank)) {
		return false;
	}
	return current.rank === previous.rank + 1;
}

export class HierarchyStack {
	entries: HierarchyEntry[];

	constructor(markers: { level: LevelType; token: string }[] = []) {
		const markersOrNull = markers.map((marker) =>
			HierarchyEntry.make(marker.level, marker.token),
		);
		this.validate(markersOrNull);
		this.entries = markersOrNull as HierarchyEntry[];
	}

	private validate(markersOrNull: (HierarchyEntry | null)[]) {
		if (markersOrNull.some((m) => !m)) {
			throw new Error("Bad marker provided to stack");
		}
		const markers = markersOrNull as HierarchyEntry[];
		if (!this.hasDenseIncreasingLevels(markers)) {
			throw new Error("Hierarchy levels must be dense + increasing");
		}
	}

	clone(): HierarchyStack {
		return new HierarchyStack(this.entries);
	}

	isEmpty(): boolean {
		return this.entries.length === 0;
	}

	findLastAtLevel(level: LevelType): HierarchyEntry | null {
		return (
			this.entries.find(({ level: testLevel }) => testLevel === level) ?? null
		);
	}

	private isFirstTokenForLevel(entry: HierarchyEntry): boolean {
		if (
			entry.level === LevelType.Section ||
			entry.level === LevelType.Subsection ||
			entry.level === LevelType.Paragraph ||
			entry.level === LevelType.Subparagraph ||
			entry.level === LevelType.Clause ||
			entry.level === LevelType.Subclause ||
			entry.level === LevelType.Item ||
			entry.level === LevelType.Subitem
		) {
			return entry.rank === 1;
		}
		return false;
	}

	private isValidChainShape(chain: HierarchyEntry[]): boolean {
		if (chain.length === 0) {
			return false;
		}

		let last = chain[0];
		for (const token of chain.slice(1)) {
			if (token.level !== last.level + 1 || token.rank !== 1) {
				return false;
			}
			last = token;
		}

		return true;
	}

	private hasDenseIncreasingLevels(markers: HierarchyEntry[]): boolean {
		if (markers.length === 0) {
			return true;
		}
		let lastLevel = markers[0].level;
		for (const { level } of markers.slice(1)) {
			if (level !== lastLevel + 1) {
				return false;
			}
			lastLevel = level;
		}
		return true;
	}

	private appliedEntries(chain: HierarchyEntry[]): HierarchyEntry[] {
		if (chain.length === 0) {
			return this.entries;
		}
		const next = chain[0];
		const matchingIndex = this.entries.findIndex(
			({ level }) => next.level <= level,
		);
		if (matchingIndex >= 0) {
			// Cut off entries at matchingIndex and after.
			return [...this.entries.slice(0, matchingIndex), ...chain];
		}
		// All existing entries come after the head of this chain, so we just ascended.
		return [...chain];
	}

	/**
	 * NB throws on bad tokens.
	 * @param tokens Tokens to resolve.
	 * @returns resolved tokens
	 */
	resolveMarkersInContext(tokens: string[]): HierarchyEntry[] {
		const tailLevel =
			this.entries.length > 0 ? this.entries[this.entries.length - 1].level : 0;

		return tokens.map((token) => {
			const isAmbiguousRomanSubsection = /^[ivxlc]$/.test(token);
			const isAmbiguousRomanSubparagraph = /^[IVXLC]$/.test(token);
			// Resolve ambiguities as sibling or child.
			let level = defaultLevelForToken(token);
			if (isAmbiguousRomanSubsection && tailLevel >= LevelType.Subparagraph) {
				level = LevelType.Clause;
			} else if (
				isAmbiguousRomanSubparagraph &&
				tailLevel >= LevelType.Clause
			) {
				level = LevelType.Subclause;
			}
			const result = HierarchyEntry.make(level, token);
			if (!result) throw new Error(`Bad token ${token}.`);
			return result;
		});
	}

	continuationRelation(
		chain: HierarchyEntry[],
	): HierarchyContinuationRelation | null {
		if (chain.length === 0) {
			throw new Error("Can't resolve empty chain.");
		}

		if (!this.isValidChainShape(chain)) {
			return null;
		}

		// Empty stack.
		if (this.entries.length === 0) {
			return "descend";
		}

		const next = chain[0];
		const head = this.entries[0];
		const tail = this.entries[this.entries.length - 1];

		// Check descendant.
		if (
			next.level === tail.level + 1 ||
			(tail.level === LevelType.Section && next.level === LevelType.Paragraph)
		) {
			// Descendant case: first must have rank 1.
			return next.rank === 1 ? "descend" : null;
		}

		// Check next-sibling.
		if (next.level === tail.level) {
			return next.rank === tail.rank + 1 ? "sibling" : null;
		}

		// Check parent-next-sibling.
		if (tail.level > next.level) {
			const matching = this.entries.find(({ level }) => level === next.level);
			if (matching) {
				// If there's an element at the level we're trying to ascend to, next must be after it.
				return next.rank === matching.rank + 1 ? "ascend" : null;
			} else if (next.level < head.level) {
				// If we're going back to a level before the known stack, always works if the chain is valid.
				return "ascend";
			} else {
				// Shouldn't happen as range of levels is contiguous.
				return null;
			}
		}

		// Failed to match any known-good case.
		return null;
	}

	canApply(chain: HierarchyEntry[]): boolean {
		if (!this.isValidChainShape(chain)) {
			return false;
		}
		return this.hasDenseIncreasingLevels(this.appliedEntries(chain));
	}

	consistencyPenalty(
		tokens: string[],
		features: HierarchyPenaltyContext,
	): number {
		const resolved = this.resolveMarkersInContext(tokens);
		const resolvedTail = resolved[resolved.length - 1];
		if (!resolvedTail) return 0;

		let penalty = 0;
		const top = this.entries[this.entries.length - 1];

		if (top && resolvedTail.level > top.level + 1) {
			penalty -= 6;
		}
		if (
			top &&
			resolvedTail.level < top.level - 1 &&
			!features.largeIndentDecrease
		) {
			penalty -= 2;
		}

		const previousSameLevel = this.findLastAtLevel(resolvedTail.level);
		if (
			previousSameLevel &&
			!isValidSiblingProgression(previousSameLevel, resolvedTail)
		) {
			penalty -= 4;
		}
		if (
			previousSameLevel &&
			/^\d+$/.test(previousSameLevel.token) &&
			/^\d+$/.test(resolvedTail.token) &&
			Number(resolvedTail.token) < Number(previousSameLevel.token)
		) {
			penalty -= 8;
		}

		const isDeeperThanTop = top ? resolvedTail.level > top.level : false;
		if (
			isDeeperThanTop &&
			resolvedTail.level === top.level + 1 &&
			!this.isFirstTokenForLevel(resolvedTail)
		) {
			penalty -= 2;
		}

		return penalty;
	}

	applyChain(chain: HierarchyEntry[]): void {
		if (chain.length === 0) return;
		this.entries = this.appliedEntries(chain);
		this.validate(this.entries);
	}
}
