import type { Review } from "../../engine/types.js";

/**
 * A unit that did not produce a result on the previous attempt. Carried into
 * the next attempt so the implementer can see why the prior run was rejected.
 */
export interface UnitMissing<U> {
	unit: U;
	unitId: string;
	paths: string[];
	rejectionContext: string;
}

export interface FanOutOpts<U, R> {
	units: U[];
	getUnitId: (unit: U) => string;
	maxConcurrent: number;
	maxAttempts: number;
	runUnit: (
		unit: U,
		rejectionContext: string | undefined,
		attemptIndex: number,
	) => Promise<R | null>;
	mergeResult: (prior: R | undefined, next: R) => R;
	findMissing: (results: Map<string, R>) => UnitMissing<U>[];
	reviewerIdPrefix: string;
}

export interface FanOutResult<R> {
	status: "pass" | "reject";
	reviews?: Review[];
	results: Map<string, R>;
}

/**
 * Run a fan-out with per-unit retry.
 *
 * On each attempt, every unit still flagged as missing is dispatched to
 * `runUnit` in parallel (bounded by `maxConcurrent`). A non-null return is
 * merged into the results map via `mergeResult`; a null return leaves the unit
 * flagged. After `maxAttempts`, any unit still missing produces one reject
 * `Review` carrying its latest `rejectionContext`.
 */
export async function runFanOutWithPerUnitRetry<U, R>(
	opts: FanOutOpts<U, R>,
): Promise<FanOutResult<R>> {
	const results = new Map<string, R>();

	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		const missing: UnitMissing<U>[] =
			attempt === 1
				? opts.units.map((u) => ({
						unit: u,
						unitId: opts.getUnitId(u),
						paths: [],
						rejectionContext: "",
					}))
				: opts.findMissing(results);

		if (missing.length === 0) {
			return { status: "pass", results };
		}

		let cursor = 0;
		const runNext = async (): Promise<void> => {
			while (cursor < missing.length) {
				const idx = cursor++;
				const m = missing[idx];
				const rejCtx =
					attempt === 1 ? undefined : m.rejectionContext || undefined;
				const r = await opts.runUnit(m.unit, rejCtx, attempt);
				if (r !== null) {
					const prior = results.get(m.unitId);
					results.set(m.unitId, opts.mergeResult(prior, r));
				}
			}
		};

		const workerCount = Math.min(opts.maxConcurrent, missing.length);
		const workers: Promise<void>[] = [];
		for (let w = 0; w < workerCount; w++) workers.push(runNext());
		await Promise.all(workers);
	}

	const stillMissing = opts.findMissing(results);
	if (stillMissing.length === 0) {
		return { status: "pass", results };
	}

	const reviews: Review[] = stillMissing.map((m) => ({
		reviewerId: `${opts.reviewerIdPrefix}/${m.unitId}`,
		verdict: "reject" as const,
		findings: m.rejectionContext,
		rejectionContext: m.rejectionContext,
	}));

	return { status: "reject", reviews, results };
}
