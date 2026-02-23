const SINGLE_UNICODE_FRACTIONS = new Map<string, string>([
	["1/2", "½"],
	["1/3", "⅓"],
	["2/3", "⅔"],
	["1/4", "¼"],
	["3/4", "¾"],
	["1/5", "⅕"],
	["2/5", "⅖"],
	["3/5", "⅗"],
	["4/5", "⅘"],
	["1/6", "⅙"],
	["5/6", "⅚"],
	["1/7", "⅐"],
	["1/8", "⅛"],
	["3/8", "⅜"],
	["5/8", "⅝"],
	["7/8", "⅞"],
	["1/9", "⅑"],
	["1/10", "⅒"],
	["0/3", "↉"],
]);

export function normalizeFractionSlashFractions(s: string): string {
	return s.replaceAll(/(\d+)⁄(\d+)/g, (match, numerator, denominator) => {
		const direct = SINGLE_UNICODE_FRACTIONS.get(`${numerator}/${denominator}`);
		if (direct) return direct;

		if (numerator.length > 1) {
			const integerPart = numerator.slice(0, -1);
			const fractionalNumerator = numerator.at(-1);
			if (!fractionalNumerator) return match;
			const fractional = SINGLE_UNICODE_FRACTIONS.get(
				`${fractionalNumerator}/${denominator}`,
			);
			if (fractional) return `${integerPart}${fractional}`;
		}

		return match;
	});
}
