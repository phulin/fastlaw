import wordsRaw from "./words.txt?raw";

const dictionaryWords = wordsRaw
	.split("\n")
	.map((word) => word.trim().toLowerCase())
	.filter((word) => word.length > 0);

export const wordDictionary = new Set(dictionaryWords);
