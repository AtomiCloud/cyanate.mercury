import { describe, expect, it } from "bun:test";
import { clusterToOps } from "./ops-ify.js";

describe("clusterToOps", () => {
	it("emits a flat op for a terminal-segment rename", () => {
		const ops = clusterToOps({
			paths: ["footer.mobile", "footer.phone"],
			suggestedCanonical: "footer.phone",
			evidence: {},
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toEqual({
			kind: "flat",
			from: "footer.mobile",
			to: "footer.phone",
			reason: expect.any(String),
		});
	});

	it("emits N flat ops for N non-canonical sources in a flat cluster", () => {
		const ops = clusterToOps({
			paths: ["footer.phone", "footer.mobile", "footer.tel"],
			suggestedCanonical: "footer.phone",
			evidence: {},
		});
		expect(ops).toHaveLength(2);
		expect(ops.every((o) => o.kind === "flat")).toBe(true);
	});

	it("emits a subtree op when paths share a wildcard-preceded suffix", () => {
		const ops = clusterToOps({
			paths: [
				"header.nav[*].submenu[*].href",
				"header.nav[*].children[*].href",
			],
			suggestedCanonical: "header.nav[*].children[*].href",
			evidence: {},
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toEqual({
			kind: "subtree",
			fromPrefix: "header.nav[*].submenu",
			toPrefix: "header.nav[*].children",
			reason: expect.any(String),
		});
	});

	it("emits subtree ops for multi-source wildcard clusters", () => {
		const ops = clusterToOps({
			paths: [
				"header.nav[*].submenu[*].href",
				"header.nav[*].dropdown[*].href",
				"header.nav[*].children[*].href",
			],
			suggestedCanonical: "header.nav[*].children[*].href",
			evidence: {},
		});
		expect(ops).toHaveLength(2);
		expect(ops.every((o) => o.kind === "subtree")).toBe(true);
	});

	it("throws when cluster contains only the canonical (no sources)", () => {
		expect(() =>
			clusterToOps({
				paths: ["footer.phone"],
				suggestedCanonical: "footer.phone",
				evidence: {},
			}),
		).toThrow();
	});

	it("uses a flat op when the wildcard suffix is absent", () => {
		// Paths differ at a terminal segment — no shared wildcard-preceded suffix.
		const ops = clusterToOps({
			paths: ["footer.contact_info.phone", "footer.contact_information.phone"],
			suggestedCanonical: "footer.contact_info.phone",
			evidence: {},
		});
		expect(ops[0].kind).toBe("flat");
	});
});
