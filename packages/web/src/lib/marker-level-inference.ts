export type MarkerHierarchyType =
	| "subsection"
	| "paragraph"
	| "subparagraph"
	| "clause"
	| "subclause"
	| "item"
	| "subitem";

export interface MarkerInferenceParagraph {
	markers: string[];
	indentationHint?: number;
}

export interface InferredMarkerLevel {
	type: MarkerHierarchyType;
	rank: number;
}

function getMarkerHierarchyRank(type: MarkerHierarchyType): number {
	switch (type) {
		case "subsection":
			return 1;
		case "paragraph":
			return 2;
		case "subparagraph":
			return 3;
		case "clause":
			return 4;
		case "subclause":
			return 5;
		case "item":
			return 6;
		case "subitem":
			return 7;
	}
}

function isLowerRoman(value: string): boolean {
	return /^[ivxlc]+$/.test(value);
}

function isUpperRoman(value: string): boolean {
	return /^[IVXLCDM]+$/.test(value);
}

export function inferMarkerTypeFromContext(
	label: string,
	previousType: MarkerHierarchyType | undefined,
	indentationHint: number,
): MarkerHierarchyType {
	if (/^\d+$/.test(label)) return "paragraph";

	if (
		isLowerRoman(label) &&
		(previousType === undefined
			? indentationHint > 1
			: getMarkerHierarchyRank(previousType) >=
				getMarkerHierarchyRank("subparagraph"))
	) {
		return "clause";
	}

	if (
		isUpperRoman(label) &&
		(previousType === undefined
			? indentationHint > 3
			: getMarkerHierarchyRank(previousType) >=
				getMarkerHierarchyRank("clause"))
	) {
		return "subclause";
	}

	if (/^[a-z]+$/.test(label)) {
		if (
			previousType !== undefined &&
			getMarkerHierarchyRank(previousType) >=
				getMarkerHierarchyRank("subclause")
		) {
			return "item";
		}
		if (label.length > 1) return "item";
		return indentationHint > 5 ? "item" : "subsection";
	}

	if (/^[A-Z]$/.test(label)) return "subparagraph";
	if (/^[A-Z]+$/.test(label)) return "item";
	return "item";
}

export function buildInferredMarkerLevels(
	paragraphs: MarkerInferenceParagraph[],
): InferredMarkerLevel[][] {
	return paragraphs.map((paragraph) => {
		let previousType: MarkerHierarchyType | undefined;
		const indentationHint = paragraph.indentationHint ?? 0;
		return paragraph.markers.map((label) => {
			const type = inferMarkerTypeFromContext(
				label,
				previousType,
				indentationHint,
			);
			previousType = type;
			return { type, rank: getMarkerHierarchyRank(type) };
		});
	});
}
