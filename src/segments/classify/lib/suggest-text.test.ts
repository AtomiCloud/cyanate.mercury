import { describe, expect, it } from "bun:test";
import type { PageTypeDigest } from "./harmonize-types.js";
import {
	compactValueForSuggest,
	interpretSuggestionsText,
	isDoneSuggestionText,
	stripDigestForSuggest,
} from "./suggest-text.js";

describe("stripDigestForSuggest", () => {
	it("keeps only path, coverage, and compact values", () => {
		const digest: PageTypeDigest = {
			pagetype: "team_member",
			totalPages: 4,
			pageHashes: ["p0", "p1", "p2", "p3"],
			candidates: [
				{
					candidatePath: "footer.contact.email",
					distinctValues: [
						{ value: "hello@example.com", pageHashes: ["p0", "p1", "p2"] },
					],
					presentOn: ["p0", "p1", "p2"],
					absentFrom: ["p3"],
				},
			],
		};

		expect(stripDigestForSuggest(digest)).toEqual({
			pagetype: "team_member",
			candidates: [
				{
					candidatePath: "footer.contact.email",
					coverage: 0.75,
					values: ["hello@example.com"],
				},
			],
		});
	});
});

describe("compactValueForSuggest", () => {
	it("truncates nested objects and long arrays", () => {
		const value = {
			title: "A",
			items: [1, 2, 3, 4, 5, 6],
			extra1: true,
			extra2: true,
			extra3: true,
			extra4: true,
			extra5: true,
			extra6: true,
			extra7: true,
			extra8: true,
			extra9: true,
			extra10: true,
			extra11: true,
			extra12: true,
			extra13: true,
		};
		expect(compactValueForSuggest(value)).toEqual({
			title: "A",
			items: [1, 2, 3, 4, 5, "... 1 more item(s)"],
			extra1: true,
			extra2: true,
			extra3: true,
			extra4: true,
			extra5: true,
			extra6: true,
			extra7: true,
			extra8: true,
			extra9: true,
			extra10: true,
			__truncatedKeys: 3,
		});
	});
});

describe("suggestions text helpers", () => {
	it("treats DONE lines as terminal", () => {
		expect(isDoneSuggestionText("DONE: nothing left")).toBe(true);
		expect(interpretSuggestionsText("DONE: nothing left")).toEqual({
			done: true,
			reason: "nothing left",
		});
	});

	it("treats non-DONE text as more work remaining", () => {
		expect(isDoneSuggestionText("Possible merge:\n- a\n- b")).toBe(false);
		expect(interpretSuggestionsText("Possible merge:\n- a\n- b")).toEqual({
			done: false,
		});
	});
});
