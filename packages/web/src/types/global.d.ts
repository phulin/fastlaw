import type { PageData } from "~/App";

declare global {
	interface Window {
		__PAGE_DATA__?: PageData;
		__SSR__?: boolean;
	}
}
