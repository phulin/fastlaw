import type { DocData } from "~/App";

declare global {
	interface Window {
		__DOC_DATA__?: DocData;
		__SSR__?: boolean;
	}
}
