import { describe, expect, it } from "bun:test";
import type { PageTypeDigest, VerdictTable } from "./harmonize-types.js";
import { validateVerdicts } from "./harmonize-verdicts-validate.js";

function digestOf(
	pagesPerCandidate: Record<string, Array<{ hash: string; value: unknown }>>,
	allPages: string[],
): PageTypeDigest {
	const candidates = Object.entries(pagesPerCandidate).map(([path, rows]) => {
		const byHash = new Map<string, { value: unknown; pageHashes: string[] }>();
		for (const r of rows) {
			const k = JSON.stringify(r.value) ?? "null";
			const b = byHash.get(k);
			if (b) b.pageHashes.push(r.hash);
			else byHash.set(k, { value: r.value, pageHashes: [r.hash] });
		}
		const presentOn = [...new Set(rows.map((r) => r.hash))].sort();
		return {
			candidatePath: path,
			distinctValues: [...byHash.values()],
			presentOn,
			absentFrom: allPages.filter((p) => !presentOn.includes(p)),
		};
	});
	return {
		pagetype: "t",
		totalPages: allPages.length,
		pageHashes: [...allPages].sort(),
		candidates,
	};
}

describe("validateVerdicts — keep-static", () => {
	it("accepts keep-static observed=true matching an observed distinct value", () => {
		const d = digestOf(
			{
				"footer.copyright": [
					{ hash: "p1", value: "© 2025" },
					{ hash: "p2", value: "© 2025" },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "footer.copyright",
				kind: "keep-static",
				value: "© 2025",
				observed: true,
				absentFrom: [],
			},
		];
		expect(validateVerdicts(d, verdicts).valid).toBe(true);
	});

	it("accepts keep-static observed=false with rationale (normalized value)", () => {
		const d = digestOf(
			{
				"footer.phone": [
					{ hash: "p1", value: "(555) 100-2300" },
					{ hash: "p2", value: "555.100.2300" },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "footer.phone",
				kind: "keep-static",
				value: "+1-555-100-2300",
				observed: false,
				absentFrom: [],
				rationale:
					"normalized phone format — same number, different formatting",
			},
		];
		expect(validateVerdicts(d, verdicts).valid).toBe(true);
	});

	it("rejects keep-static observed=false without a rationale", () => {
		const d = digestOf(
			{
				"footer.phone": [
					{ hash: "p1", value: "(555) 100-2300" },
					{ hash: "p2", value: "555.100.2300" },
				],
			},
			["p1", "p2"],
		);
		const verdicts = [
			{
				candidatePath: "footer.phone",
				kind: "keep-static",
				value: "+1-555-100-2300",
				observed: false,
				absentFrom: [],
			},
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes("observed=false but no rationale")),
		).toBe(true);
	});

	it("rejects keep-static observed=true with value not in distinctValues", () => {
		const d = digestOf(
			{
				"footer.copyright": [
					{ hash: "p1", value: "© 2024" },
					{ hash: "p2", value: "© 2025" },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "footer.copyright",
				kind: "keep-static",
				value: "© 2026",
				observed: true,
				absentFrom: [],
			},
		];
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes('observed=true but "value" is not byte-equal'),
			),
		).toBe(true);
	});

	it("rejects keep-static missing value key", () => {
		const d = digestOf({ x: [{ hash: "p1", value: "foo" }] }, ["p1"]);
		const verdicts = [
			{
				candidatePath: "x",
				kind: "keep-static",
				observed: true,
				absentFrom: [],
			},
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes('missing a "value" field')),
		).toBe(true);
	});

	it("rejects keep-static missing observed flag", () => {
		const d = digestOf({ x: [{ hash: "p1", value: "foo" }] }, ["p1"]);
		const verdicts = [
			{
				candidatePath: "x",
				kind: "keep-static",
				value: "foo",
				absentFrom: [],
			},
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes('missing a boolean "observed" field'),
			),
		).toBe(true);
	});

	it("accepts null as an explicit value (null is a valid leaf)", () => {
		const d = digestOf(
			{
				"header.navigation[7].href": [
					{ hash: "p1", value: null },
					{ hash: "p2", value: null },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "header.navigation[7].href",
				kind: "keep-static",
				value: null,
				observed: true,
				absentFrom: [],
			},
		];
		expect(validateVerdicts(d, verdicts).valid).toBe(true);
	});

	it("rejects keep-static.absentFrom containing pages that did contribute", () => {
		const d = digestOf(
			{
				x: [
					{ hash: "p1", value: "foo" },
					{ hash: "p2", value: "foo" },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "x",
				kind: "keep-static",
				value: "foo",
				observed: true,
				absentFrom: ["p1"],
			},
		];
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes('lists page "p1" as absent')),
		).toBe(true);
	});
});

describe("validateVerdicts — keep-dynamic", () => {
	it("accepts keep-dynamic with rationale", () => {
		const d = digestOf(
			{
				"breadcrumb.trail": [
					{ hash: "p1", value: ["Home", "Blog", "Post 1"] },
					{ hash: "p2", value: ["Home", "Blog", "Post 2"] },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				pattern: "breadcrumb",
				rationale: "per-page trail derived from page location",
			},
		];
		expect(validateVerdicts(d, verdicts).valid).toBe(true);
	});

	it("rejects keep-dynamic with a value key", () => {
		const d = digestOf(
			{
				"breadcrumb.trail": [{ hash: "p1", value: ["Home", "Blog"] }],
			},
			["p1"],
		);
		const verdicts = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				value: ["Home", "Blog"],
				rationale: "breadcrumb",
			},
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes('must NOT carry a "value" key')),
		).toBe(true);
	});

	it("rejects keep-dynamic carrying a stray observed key", () => {
		const d = digestOf(
			{
				"breadcrumb.trail": [{ hash: "p1", value: ["Home"] }],
			},
			["p1"],
		);
		const verdicts = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				observed: true,
				rationale: "per-page",
			},
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes('must NOT carry an "observed" key')),
		).toBe(true);
	});

	it("rejects keep-dynamic missing rationale", () => {
		const d = digestOf(
			{
				"breadcrumb.trail": [{ hash: "p1", value: ["Home"] }],
			},
			["p1"],
		);
		const verdicts = [
			{ candidatePath: "breadcrumb.trail", kind: "keep-dynamic" },
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("rationale"))).toBe(true);
	});
});

describe("validateVerdicts — coverage, duplicates, fabrication", () => {
	it("rejects missing verdicts", () => {
		const d = digestOf(
			{
				"header.navigation[2].href": [
					{ hash: "p1", value: "/spine-physiotherapy/" },
					{ hash: "p2", value: null },
				],
				"header.navigation[7].href": [
					{ hash: "p1", value: null },
					{ hash: "p2", value: null },
				],
			},
			["p1", "p2"],
		);
		const verdicts: VerdictTable = [
			{
				candidatePath: "header.navigation[2].href",
				kind: "defer-to-operator",
				rationale: "disagreement",
			},
		];
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes('missing verdict for "header.navigation[7].href"'),
			),
		).toBe(true);
	});

	it("rejects demote / defer without rationale", () => {
		const d = digestOf({ x: [{ hash: "p1", value: "foo" }] }, ["p1"]);
		const verdicts = [
			{ candidatePath: "x", kind: "demote" },
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("rationale"))).toBe(true);
	});

	it("rejects duplicate verdicts for the same candidate", () => {
		const d = digestOf({ x: [{ hash: "p1", value: "foo" }] }, ["p1"]);
		const verdicts: VerdictTable = [
			{
				candidatePath: "x",
				kind: "keep-static",
				value: "foo",
				observed: true,
				absentFrom: [],
			},
			{ candidatePath: "x", kind: "demote", rationale: "no" },
		];
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("duplicate verdict"))).toBe(
			true,
		);
	});

	it("rejects fabricated candidates in verdicts", () => {
		const d = digestOf({ x: [{ hash: "p1", value: "foo" }] }, ["p1"]);
		const verdicts: VerdictTable = [
			{
				candidatePath: "x",
				kind: "keep-static",
				value: "foo",
				observed: true,
				absentFrom: [],
			},
			{ candidatePath: "made-up", kind: "demote", rationale: "nope" },
		];
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes('"made-up" does not correspond to any observed candidate'),
			),
		).toBe(true);
	});

	it("rejects unsupported kind", () => {
		const d = digestOf({ x: [{ hash: "p1", value: "foo" }] }, ["p1"]);
		const verdicts = [
			{ candidatePath: "x", kind: "keep-majority", value: "foo" },
		] as unknown as VerdictTable;
		const result = validateVerdicts(d, verdicts);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes('unsupported kind "keep-majority"')),
		).toBe(true);
	});
});
