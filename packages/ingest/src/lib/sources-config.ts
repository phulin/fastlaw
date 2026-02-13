import sourceData from "../../sources.json";

export interface SourceConfig {
	name: string;
	jurisdiction: string;
	region: string;
	doc_type: string;
	description: string;
}

interface SourcesData {
	sources: Record<string, SourceConfig>;
}

const sources = (sourceData as SourcesData).sources;

export function getSourceConfig(sourceCode: string): SourceConfig | null {
	return sources[sourceCode] ?? null;
}

export function getAllSourceCodes(): string[] {
	return Object.keys(sources);
}

export function validateSourceCode(sourceCode: string): boolean {
	return sourceCode in sources;
}
