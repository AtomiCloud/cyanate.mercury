import { describe, expect, it } from "bun:test";
import { appendRejectEntry, normalizeRejectEntry } from "./rejects.js";

describe("normalizeRejectEntry", () => {
	it("sorts and deduplicates paths", () => {
		expect(
			normalizeRejectEntry({
				paths: ["b", "a", "b"],
				reason: "no",
			}),
		).toEqual({
			paths: ["a", "b"],
			reason: "no",
		});
	});

	it("requires at least two distinct paths", () => {
		expect(() => normalizeRejectEntry({ paths: ["a", "a"] })).toThrow(
			/at least 2 distinct paths/i,
		);
	});
});

describe("appendRejectEntry", () => {
	it("appends normalized rejects without mutating existing entries", () => {
		const existing = [{ paths: ["x", "y"], reason: "old" }];
		const out = appendRejectEntry(existing, { paths: ["b", "a"] });
		expect(existing).toEqual([{ paths: ["x", "y"], reason: "old" }]);
		expect(out).toEqual([
			{ paths: ["x", "y"], reason: "old" },
			{ paths: ["a", "b"], reason: "agent rejected cluster" },
		]);
	});
});
