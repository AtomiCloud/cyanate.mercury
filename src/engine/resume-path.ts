/**
 * Path-based resume for the `run` command.
 *
 * When `--from <value>` looks like a path, we parse it into source-run
 * metadata and prepare the target run dir (either a new clone or the same
 * dir in place) so the rest of the engine — which already handles
 * `--run-id` + `--from <phase>` + `--dep` — can take over unchanged.
 *
 * Accepted path shapes (relative or absolute):
 *
 *   runs/<run-id>/<segment>                        — restart the segment
 *                                                    from its first phase.
 *                                                    Deps inherited from source.
 *
 *   runs/<run-id>/<segment>/iteration-<N>-<phase>  — resume from iteration N.
 *                                                    If N passed: start at
 *                                                    the phase AFTER it.
 *                                                    If N didn't: re-run it.
 *
 * Cloning vs in-place is determined by whether `targetRunId` matches the
 * source runId parsed from the path. Match → in-place (truncate). Differ →
 * clone (copy segment dir, then truncate on the copy).
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SegmentRegistry } from "./registry.js";
import {
	readPipelineState,
	readRunState,
	writePipelineState,
} from "./state.js";

export interface ResumeFromPathInput {
	rootDir: string;
	fromPath: string;
	targetRunId?: string;
	registry: SegmentRegistry;
}

export interface ResumeFromPathResult {
	runId: string;
	startSegment: string;
	fromPhase?: string;
	depOverrides: Record<string, string>;
}

interface ParsedPath {
	sourceRunId: string;
	sourceRunDir: string;
	segmentId: string;
	iterationIndex?: number;
	iterationPhaseId?: string;
}

/**
 * Detect whether a `--from` value is a path (should hit this module) or a
 * bare phase name (legacy behavior). Simple heuristic: paths contain a `/`.
 */
export function looksLikePath(fromValue: string): boolean {
	return fromValue.includes("/");
}

export async function prepareResumeFromPath(
	opts: ResumeFromPathInput,
): Promise<ResumeFromPathResult> {
	const parsed = parsePath(opts.fromPath, opts.rootDir);

	if (!opts.registry.has(parsed.segmentId)) {
		throw new Error(
			`--from path references segment "${parsed.segmentId}" but no such segment is registered. Known: ${opts.registry.listIds().join(", ")}`,
		);
	}

	const sourceRun = await readRunState(parsed.sourceRunDir);
	if (!sourceRun) {
		throw new Error(
			`--from path: no run.json found at ${parsed.sourceRunDir}/run.json`,
		);
	}

	const targetRunId = opts.targetRunId ?? generateTimestamp();
	const targetRunDir = join(opts.rootDir, "runs", targetRunId);
	const inPlace = targetRunId === parsed.sourceRunId;

	const depOverrides = inheritDepOverrides(sourceRun);

	if (!inPlace) {
		await cloneSegmentDir(parsed.sourceRunDir, targetRunDir, parsed.segmentId);
	}

	const targetSegDir = join(targetRunDir, parsed.segmentId);

	let fromPhase: string | undefined;
	if (parsed.iterationIndex !== undefined) {
		fromPhase = await applyIterationTruncation(
			targetSegDir,
			targetRunId,
			parsed.iterationIndex,
			parsed.segmentId,
			opts.registry,
		);
	} else {
		await wipeSegmentForFreshStart(targetSegDir);
		fromPhase = undefined;
	}

	return {
		runId: targetRunId,
		startSegment: parsed.segmentId,
		fromPhase,
		depOverrides,
	};
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

export function parsePath(raw: string, rootDir: string): ParsedPath {
	const abs = isAbsolute(raw) ? raw : resolve(rootDir, raw);
	const rel = relative(rootDir, abs);
	if (rel.startsWith("..") || rel === "") {
		throw new Error(
			`--from path: "${raw}" is not under ${rootDir}/runs — use a run dir under the current workspace`,
		);
	}
	const parts = rel.split("/").filter(Boolean);
	if (parts[0] !== "runs") {
		throw new Error(`--from path: must start with "runs/…" (got "${rel}")`);
	}
	if (parts.length < 3 || parts.length > 4) {
		throw new Error(
			`--from path: expected "runs/<run-id>/<segment>[/iteration-<N>-<phase>]" (got "${rel}")`,
		);
	}
	const sourceRunId = parts[1];
	const sourceRunDir = join(rootDir, "runs", sourceRunId);
	const segmentId = parts[2];

	if (parts.length === 3) {
		return { sourceRunId, sourceRunDir, segmentId };
	}

	const iterName = parts[3];
	const m = iterName.match(/^iteration-(\d+)-(.+)$/);
	if (!m) {
		throw new Error(
			`--from path: last segment "${iterName}" is not an iteration dir. Expected "iteration-<N>-<phaseId>".`,
		);
	}
	return {
		sourceRunId,
		sourceRunDir,
		segmentId,
		iterationIndex: Number(m[1]),
		iterationPhaseId: m[2],
	};
}

// ---------------------------------------------------------------------------
// Dep inheritance (completed segments + prior --dep overrides)
// ---------------------------------------------------------------------------

function inheritDepOverrides(
	sourceRun: import("./types.js").RunState,
): Record<string, string> {
	const depOverrides: Record<string, string> = {
		...(sourceRun.depOverrides ?? {}),
	};
	for (const [id, s] of Object.entries(sourceRun.segments)) {
		if (s.status === "completed" && s.outputDir) {
			depOverrides[id] = s.outputDir;
		}
	}
	return depOverrides;
}

// ---------------------------------------------------------------------------
// Segment dir cloning (for cross-run resume)
// ---------------------------------------------------------------------------

async function cloneSegmentDir(
	sourceRunDir: string,
	targetRunDir: string,
	segmentId: string,
): Promise<void> {
	const tgt = join(targetRunDir, segmentId);
	// Guard: never silently clobber a target that already has work persisted.
	// `pipeline.json` is the tell — segment-runner writes it as soon as any
	// iteration starts. If present, require an empty target (operator deletes
	// it explicitly) rather than silently destroying real state.
	const hasExistingState = await fileExists(join(tgt, "pipeline.json"));
	if (hasExistingState) {
		throw new Error(
			`--from path: target "${tgt}" already has pipeline.json — refusing to clobber existing run state. Delete the target segment dir first, or pick a different --run-id.`,
		);
	}
	await mkdir(targetRunDir, { recursive: true });
	const src = join(sourceRunDir, segmentId);
	await rm(tgt, { recursive: true, force: true });
	await cp(src, tgt, { recursive: true });
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Iteration-path handling
// ---------------------------------------------------------------------------

async function applyIterationTruncation(
	segDir: string,
	targetRunId: string,
	iterationIndex: number,
	segmentId: string,
	registry: SegmentRegistry,
): Promise<string> {
	const state = await readPipelineState(segDir);
	if (!state) {
		throw new Error(
			`--from path: no pipeline.json at ${segDir}/pipeline.json — can't resume from an iteration without segment state`,
		);
	}

	const iter = state.iterations.find((i) => i.index === iterationIndex);
	if (!iter) {
		const available = state.iterations.map((i) => i.index).join(", ");
		throw new Error(
			`--from path: pipeline.json has no iteration ${iterationIndex} (present: ${available || "none"})`,
		);
	}

	const fromPhase = inferResumePhase(iter, segmentId, registry);

	// Truncate state and delete later iteration dirs.
	state.iterations = state.iterations.filter((i) => i.index <= iterationIndex);
	rewriteRetainedIterationPaths(state, segDir);
	state.runId = targetRunId;
	state.segmentId = segmentId;
	const last = state.iterations.at(-1);
	state.status = "running";
	state.currentPhase = last?.phaseId ?? state.currentPhase;
	state.currentIteration = last?.index ?? 0;
	delete state.finishedAt;
	await writePipelineState(segDir, state);

	const entries = await safeReaddir(segDir);
	for (const entry of entries) {
		const m = entry.match(/^iteration-(\d+)-/);
		if (m && Number(m[1]) > iterationIndex) {
			await rm(join(segDir, entry), { recursive: true, force: true });
		}
	}

	return fromPhase;
}

function rewriteRetainedIterationPaths(
	state: import("./types.js").PipelineState,
	segDir: string,
): void {
	for (const iter of state.iterations) {
		iter.workdir = join(segDir, `iteration-${iter.index}-${iter.phaseId}`);
	}
}

function inferResumePhase(
	iter: import("./types.js").IterationState,
	segmentId: string,
	registry: SegmentRegistry,
): string {
	const seg = registry.get(segmentId);
	const phaseIdx = seg.phases.findIndex((p) => p.id === iter.phaseId);
	if (phaseIdx === -1) {
		throw new Error(
			`--from path: iteration ${iter.index} references phase "${iter.phaseId}" which isn't in segment "${segmentId}"`,
		);
	}
	if (iter.status === "passed") {
		const next = seg.phases[phaseIdx + 1];
		if (!next) {
			throw new Error(
				`--from path: iteration ${iter.index} passed and its phase "${iter.phaseId}" is already the last phase of segment "${segmentId}"; nothing to resume`,
			);
		}
		return next.id;
	}
	// running / rejected / failed → retry that phase
	return iter.phaseId;
}

// ---------------------------------------------------------------------------
// Segment-path handling (wipe iterations, restart from first phase)
// ---------------------------------------------------------------------------

async function wipeSegmentForFreshStart(segDir: string): Promise<void> {
	const entries = await safeReaddir(segDir);
	for (const entry of entries) {
		if (/^iteration-\d+-/.test(entry) || entry === "pipeline.json") {
			await rm(join(segDir, entry), { recursive: true, force: true });
		}
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

function generateTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
