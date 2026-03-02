import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
	it("preserves double-letter markers in nested outlines", () => {
		const body = `> **(2)** **Payee statement** The term "payee statement" means any statement required to be furnished under—
>
> > **(JJ)** section 6226(a)(2) (relating to statements relating to alternative to payment of imputed underpayment by partnership),
>
> > **(KK)** subsection (a)(2), (b)(2), or (c)(2) of section 6050Y (relating to returns relating to certain life insurance contract transactions).`;

		const html = renderMarkdown(body, {});

		expect(html).toContain("(JJ)");
		expect(html).toContain("(KK)");
		expect(html).not.toContain("(JJ) 2 section");
		expect(html).not.toContain("(JJ) 2 subsection");
	});
});
