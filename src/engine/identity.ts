/**
 * Run identity resolution.
 *
 * A run's identity is the (input, reference) pair that describes *what* the
 * pipeline processed. When a new run is started with `--dep <prior-run>`, it
 * must adopt the prior run's identity — otherwise downstream segments would
 * inherit artifacts derived from one input while `ctx.config` advertised a
 * different one (e.g. prepare ran against example/royal, but cui.yaml was
 * since edited to example/physio, and a classify --dep run would claim to be
 * processing physio while actually consuming royal-derived artifacts).
 *
 * Rules:
 * - No deps → identity from current config.
 * - Per-field reconciliation: `input` and `reference` are reconciled
 *   independently. This supports the fan-in case (design depends on
 *   analyze + wireframe) where analyze owns `reference` and wireframe
 *   inherits `input` from classify/prepare.
 * - Deps that agree on a field → that value.
 * - Deps that disagree on a field → throw with field-specific error.
 * - Legacy dep (run.json without identity field) → fall back to config,
 *   logging a warning; preserves backwards compatibility with runs created
 *   before this field existed.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CuiConfig, RunIdentity, RunState } from "./types.js";

interface ResolveIdentityOptions {
	config: CuiConfig;
	depOverrides?: Record<string, string>;
	/** Optional warn callback for legacy runs; defaults to console.warn. */
	onWarn?: (msg: string) => void;
}

export async function resolveIdentity(
	opts: ResolveIdentityOptions,
): Promise<RunIdentity> {
	const { config, depOverrides, onWarn = defaultWarn } = opts;
	const configIdentity: RunIdentity = {
		input: config.input,
		reference: config.reference,
	};

	if (!depOverrides || Object.keys(depOverrides).length === 0) {
		return configIdentity;
	}

	// Collect identities from each dep's run.json
	const observed: Array<{
		depId: string;
		runId: string;
		identity: RunIdentity;
	}> = [];

	for (const [depId, depPath] of Object.entries(depOverrides)) {
		const runJsonPath = depPathToRunJson(depPath);
		const state = await readRunStateSafe(runJsonPath);

		if (!state) {
			onWarn(
				`--dep ${depId}=${depPath}: no run.json found at ${runJsonPath}. ` +
					`Falling back to cui.yaml identity for this dep.`,
			);
			continue;
		}

		if (!state.identity) {
			onWarn(
				`--dep ${depId}=${depPath} points to legacy run ${state.runId} ` +
					`without identity recorded. Falling back to cui.yaml identity for this dep.`,
			);
			continue;
		}

		observed.push({ depId, runId: state.runId, identity: state.identity });
	}

	if (observed.length === 0) {
		// All deps were legacy / unreadable — use config identity
		return configIdentity;
	}

	// Reconcile per-field: input and reference independently.
	// This supports the fan-in case (e.g. design depends on analyze +
	// wireframe) where different deps may contribute different fields.
	const input = reconcileField("input", observed, configIdentity.input);
	const reference = reconcileField(
		"reference",
		observed,
		configIdentity.reference,
	);

	return { input: input ?? configIdentity.input, reference };
}

/**
 * Given a dep path like `/.../runs/20260414-103417/prepare`, return the
 * absolute path to that run's `run.json` (`/.../runs/20260414-103417/run.json`).
 *
 * We accept the segment-dir form because that is the shape of paths stored
 * in `runState.segments[id].outputDir` and threaded through `--dep`.
 */
function depPathToRunJson(depPath: string): string {
	return join(dirname(depPath), "run.json");
}

/**
 * Reconcile a single identity field across observed deps.
 *
 * - 0 deps provided it → fallback (config value)
 * - 1+ deps agree on a value → that value
 * - 2+ deps disagree → throw a field-specific error
 */
function reconcileField(
	field: "input" | "reference",
	observed: Array<{ depId: string; runId: string; identity: RunIdentity }>,
	fallback: string | undefined,
): string | undefined {
	const values: Array<{ depId: string; runId: string; value: string }> = [];
	for (const obs of observed) {
		const val = obs.identity[field];
		if (val !== undefined && val !== null && val !== "") {
			values.push({ depId: obs.depId, runId: obs.runId, value: val });
		}
	}

	if (values.length === 0) return fallback;

	const first = values[0];
	for (const other of values.slice(1)) {
		if (first.value !== other.value) {
			const hint =
				field === "input"
					? "re-run upstream segments against the same scraper input"
					: "re-run upstream segments against the same reference URL";
			throw new Error(
				`--dep runs disagree on ${field}:\n` +
					`  ${first.depId}=<run ${first.runId}> has ${field}=${first.value}\n` +
					`  ${other.depId}=<run ${other.runId}> has ${field}=${other.value}\n` +
					`All deps must agree on ${field}. Either pass --dep values from ` +
					`a single prior run, or ${hint}.`,
			);
		}
	}

	return first.value;
}

async function readRunStateSafe(path: string): Promise<RunState | null> {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw) as RunState;
	} catch {
		return null;
	}
}

function defaultWarn(msg: string): void {
	// eslint-disable-next-line no-console
	console.warn(`[identity] ${msg}`);
}

/**
 * Format an identity mismatch between inherited and cui.yaml for informational
 * logging at run start. Returns null when they match (no divergence to report).
 */
export function describeIdentityDivergence(
	inherited: RunIdentity,
	configIdentity: RunIdentity,
): string | null {
	const inputMatch = inherited.input === configIdentity.input;
	const refMatch =
		(inherited.reference ?? null) === (configIdentity.reference ?? null);
	if (inputMatch && refMatch) return null;
	return (
		`identity inherited from --dep: input=${inherited.input}, ` +
		`reference=${inherited.reference ?? "(none)"}. ` +
		`cui.yaml values (input=${configIdentity.input}, ` +
		`reference=${configIdentity.reference ?? "(none)"}) are overridden for this run.`
	);
}
