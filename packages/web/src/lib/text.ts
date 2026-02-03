/**
 * Capitalizes the first letter of each word in a string.
 * @param str - The string to capitalize words in
 * @returns The string with each word capitalized
 */
export function capitalizeWords(str: string): string {
	return str
		.split(" ")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

/**
 * Simple pluralization function that adds 's' to the end of a word.
 * For more complex pluralization rules, consider using a library like pluralize.
 * @param count - The number of items
 * @param singular - The singular form of the word
 * @param plural - The plural form of the word (optional, defaults to singular + 's')
 * @returns The appropriately pluralized word
 */
export function pluralize(
	count: number,
	singular: string,
	plural?: string,
): string {
	if (count === 1) {
		return singular;
	}
	return plural ?? `${singular}s`;
}
