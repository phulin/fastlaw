import type { DocData, LevelData } from "~/App";

declare global {
	interface Window {
		__DOC_DATA__?: DocData;
		__LEVEL_DATA__?: LevelData;
		__SSR__?: boolean;
	}
}
