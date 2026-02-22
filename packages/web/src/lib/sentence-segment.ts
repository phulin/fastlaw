const segmenters = new Map<string, Intl.Segmenter>();

export function segment(language: string, text: string): string[] {
	let segmenter = segmenters.get(language);
	if (!segmenter) {
		try {
			segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
			segmenters.set(language, segmenter);
		} catch (e) {
			console.warn(
				`Intl.Segmenter failed for language "${language}", falling back to "en"`,
				e,
			);
			segmenter = segmenters.get("en");
			if (!segmenter) {
				segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
				segmenters.set("en", segmenter);
			}
		}
	}
	const segments = segmenter.segment(text);
	return Array.from(segments).map((s) => s.segment);
}
