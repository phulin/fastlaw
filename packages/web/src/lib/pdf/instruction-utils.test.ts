import { describe, expect, it } from "vitest";
import { ScopeKind, type TargetScopeSegment } from "../amendment-edit-tree";
import { getUscSectionPathFromScopePath } from "./instruction-utils";

describe("getUscSectionPathFromScopePath", () => {
	it("normalizes en dash in section number before creating section path", () => {
		const targetScopePath: TargetScopeSegment[] = [
			{ kind: "code_reference", label: "7 U.S.C." },
			{ kind: ScopeKind.Section, label: "1308–1" },
		];

		expect(getUscSectionPathFromScopePath(targetScopePath)).toBe(
			"/statutes/usc/section/7/1308-1",
		);
	});

	it("keeps existing hyphenated section numbers unchanged", () => {
		const targetScopePath: TargetScopeSegment[] = [
			{ kind: "code_reference", label: "7 U.S.C." },
			{ kind: ScopeKind.Section, label: "1308-1" },
		];

		expect(getUscSectionPathFromScopePath(targetScopePath)).toBe(
			"/statutes/usc/section/7/1308-1",
		);
	});
});
