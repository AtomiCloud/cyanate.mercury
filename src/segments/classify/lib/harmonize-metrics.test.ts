import { describe, expect, it } from "bun:test";
import { computeConvergenceMetrics } from "./harmonize-metrics.js";
import { applyRenameTable } from "./harmonize-rename.js";
import type { PageTypeDigest, RenameTable } from "./harmonize-types.js";

function digestWith(
	totalPages: number,
	candidates: Array<{
		path: string;
		presentOn: string[];
		values?: Array<{ value: unknown; pageHashes: string[] }>;
	}>,
): PageTypeDigest {
	const pageHashes = Array.from({ length: totalPages }, (_, i) => `p${i + 1}`);
	return {
		pagetype: "t",
		totalPages,
		pageHashes,
		candidates: candidates.map((c) => ({
			candidatePath: c.path,
			presentOn: c.presentOn,
			absentFrom: pageHashes.filter((h) => !c.presentOn.includes(h)),
			distinctValues: c.values ?? [{ value: "v", pageHashes: c.presentOn }],
		})),
	};
}

describe("computeConvergenceMetrics", () => {
	it("single page → meanJaccard is null (no pairs)", () => {
		const d = digestWith(1, [
			{ path: "a", presentOn: ["p1"] },
			{ path: "b", presentOn: ["p1"] },
		]);
		const m = computeConvergenceMetrics(d, d, []);
		expect(m.totalPages).toBe(1);
		expect(m.meanJaccardBefore).toBe(null);
		expect(m.meanJaccardAfter).toBe(null);
		expect(m.candidatesBefore).toBe(2);
		expect(m.candidatesAfter).toBe(2);
		expect(m.sharedOnAllBefore).toBe(2);
		expect(m.foldBuckets).toEqual([]);
	});

	it("rename collapses aliases → sharedOnAll goes up, candidates go down, jaccard rises", () => {
		// Two pages. One uses `nav`, the other uses `navigation`. Same
		// bucket semantically; a rename `nav → navigation` should collapse
		// them.
		const before = digestWith(2, [
			{ path: "nav", presentOn: ["p1"] },
			{ path: "navigation", presentOn: ["p2"] },
			{ path: "logo", presentOn: ["p1", "p2"] },
		]);
		const flat: RenameTable = [{ from: "nav", to: "navigation", reason: "" }];
		const after = applyRenameTable(before, flat);

		const m = computeConvergenceMetrics(before, after, flat);
		expect(m.candidatesBefore).toBe(3);
		expect(m.candidatesAfter).toBe(2); // navigation + logo
		expect(m.sharedOnAllBefore).toBe(1); // only logo
		expect(m.sharedOnAllAfter).toBe(2); // navigation + logo
		// Before: jaccard(p1, p2) = |{logo}| / |{nav, navigation, logo}| = 1/3
		expect(m.meanJaccardBefore).toBeCloseTo(1 / 3, 5);
		// After: both pages have {navigation, logo}
		expect(m.meanJaccardAfter).toBe(1);
	});

	it("empty rename table → metrics before == after; no fold buckets", () => {
		const d = digestWith(3, [
			{ path: "a", presentOn: ["p1", "p2"] },
			{ path: "b", presentOn: ["p2", "p3"] },
			{ path: "c", presentOn: ["p1", "p3"] },
		]);
		const m = computeConvergenceMetrics(d, d, []);
		expect(m.candidatesBefore).toBe(m.candidatesAfter);
		expect(m.sharedOnAllBefore).toBe(m.sharedOnAllAfter);
		expect(m.meanJaccardBefore).toBe(m.meanJaccardAfter);
		expect(m.foldBuckets).toEqual([]);
	});

	it("foldBuckets surfaces each canonical with its source set", () => {
		const before = digestWith(2, [
			{ path: "footer.contact_info.email", presentOn: ["p1"] },
			{ path: "footer.contact_information.email", presentOn: ["p2"] },
			{ path: "footer.mobile", presentOn: ["p1"] },
			{ path: "footer.phone", presentOn: ["p2"] },
		]);
		const flat: RenameTable = [
			{
				from: "footer.contact_info.email",
				to: "footer.email",
				reason: "",
			},
			{
				from: "footer.contact_information.email",
				to: "footer.email",
				reason: "",
			},
			{ from: "footer.mobile", to: "footer.phone", reason: "" },
		];
		const after = applyRenameTable(before, flat);
		const m = computeConvergenceMetrics(before, after, flat);

		const emailBucket = m.foldBuckets.find(
			(b) => b.canonical === "footer.email",
		);
		expect(emailBucket).toBeDefined();
		expect(emailBucket?.sources).toEqual([
			"footer.contact_info.email",
			"footer.contact_information.email",
		]);
		expect(emailBucket?.pagesWithBucket).toBe(2);

		const phoneBucket = m.foldBuckets.find(
			(b) => b.canonical === "footer.phone",
		);
		expect(phoneBucket).toBeDefined();
		expect(phoneBucket?.sources).toEqual(["footer.mobile"]);
	});

	it("no-collapse rename that still creates a new canonical → 1-source fold bucket", () => {
		// Agent renamed `x → y` when `y` wasn't an existing candidate; this
		// isn't a real merge but surfaces as a 1-source bucket so the reviewer
		// can judge whether the synthetic canonical is justified.
		const before = digestWith(2, [{ path: "x", presentOn: ["p1", "p2"] }]);
		const flat: RenameTable = [{ from: "x", to: "y", reason: "" }];
		const after = applyRenameTable(before, flat);
		const m = computeConvergenceMetrics(before, after, flat);
		expect(m.foldBuckets).toHaveLength(1);
		expect(m.foldBuckets[0].canonical).toBe("y");
		expect(m.foldBuckets[0].sources).toEqual(["x"]);
	});
});
