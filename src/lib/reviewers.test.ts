import { describe, expect, test } from "bun:test";
import type { Review } from "../engine/types.js";
import {
	aggregateReviewerVerdicts,
	evidencePath,
	parseReviewerVerdict,
	reviewPath,
} from "./reviewers.js";

// ---------------------------------------------------------------------------
// parseReviewerVerdict
// ---------------------------------------------------------------------------

describe("parseReviewerVerdict", () => {
	test("VERDICT: PASS → pass", () => {
		const result = parseReviewerVerdict(
			"The layout looks good.\n\nVERDICT: PASS",
		);
		expect(result.verdict).toBe("pass");
		expect(result.findings).toContain("VERDICT: PASS");
	});

	test("VERDICT:PASS (no space) → pass", () => {
		const result = parseReviewerVerdict("Looks great.\nVERDICT:PASS");
		expect(result.verdict).toBe("pass");
	});

	test("VERDICT: REJECT → reject", () => {
		const result = parseReviewerVerdict(
			"Layout issues found.\n\nVERDICT: REJECT\nREJECTION CONTEXT: Grid alignment is off on mobile.",
		);
		expect(result.verdict).toBe("reject");
		expect(result.rejectionContext).toBe("Grid alignment is off on mobile.");
	});

	test("VERDICT:REJECT (no space) → reject", () => {
		const result = parseReviewerVerdict("VERDICT:REJECT");
		expect(result.verdict).toBe("reject");
	});

	test("malformed output → reject (fail-safe)", () => {
		const result = parseReviewerVerdict(
			"I looked at the files and they seem okay.",
		);
		expect(result.verdict).toBe("reject");
		expect(result.rejectionContext).toContain(
			'VERDICT: PASS" or "VERDICT: REJECT"',
		);
	});

	test("empty output → reject (fail-safe)", () => {
		const result = parseReviewerVerdict("");
		expect(result.verdict).toBe("reject");
	});
});

// ---------------------------------------------------------------------------
// aggregateReviewerVerdicts
// ---------------------------------------------------------------------------

describe("aggregateReviewerVerdicts", () => {
	test("all pass → pass", () => {
		const verdicts: Review[] = [
			{ reviewerId: "r1", verdict: "pass", findings: "ok" },
			{ reviewerId: "r2", verdict: "pass", findings: "ok" },
		];
		const result = aggregateReviewerVerdicts(verdicts);
		expect(result.status).toBe("pass");
	});

	test("one reject → reject with merged findings", () => {
		const verdicts: Review[] = [
			{ reviewerId: "r1", verdict: "pass", findings: "ok" },
			{
				reviewerId: "r2",
				verdict: "reject",
				findings: "bad layout",
				rejectionContext: "Grid broken",
			},
		];
		const result = aggregateReviewerVerdicts(verdicts);
		expect(result.status).toBe("reject");
		expect(result.reviews).toHaveLength(2);
	});

	test("empty array → pass", () => {
		const result = aggregateReviewerVerdicts([]);
		expect(result.status).toBe("pass");
	});
});

// ---------------------------------------------------------------------------
// Path construction
// ---------------------------------------------------------------------------

describe("evidencePath", () => {
	test("correct path construction", () => {
		expect(evidencePath("/work/runs/1/workdir", 1)).toBe(
			"/work/runs/1/workdir/evidence/1",
		);
		expect(evidencePath("/work/runs/1/workdir", 3)).toBe(
			"/work/runs/1/workdir/evidence/3",
		);
	});
});

describe("reviewPath", () => {
	test("correct path construction", () => {
		expect(reviewPath("/work/runs/1/workdir", 1)).toBe(
			"/work/runs/1/workdir/reviews/1",
		);
		expect(reviewPath("/work/runs/1/workdir", 2)).toBe(
			"/work/runs/1/workdir/reviews/2",
		);
	});
});
