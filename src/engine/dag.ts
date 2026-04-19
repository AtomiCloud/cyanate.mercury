/**
 * DAG executor for segments.
 *
 * Segments form a DAG via their `depends` fields.
 * Independent segments run in parallel; dependent segments wait.
 */

import type { PipelineLogger } from "../lib/logger.js";
import { describeIdentityDivergence, resolveIdentity } from "./identity.js";
import { MetricsWriter } from "./metrics.js";
import type { SegmentRegistry } from "./registry.js";
import { runSegment, type SegmentRunResult } from "./segment-runner.js";
import { createRunState, writeRunState } from "./state.js";
import type { CuiConfig, RunState } from "./types.js";
import { createRunDir } from "./workdir.js";

export interface DagRunOptions {
	registry: SegmentRegistry;
	config: CuiConfig;
	logger: PipelineLogger;
	rootDir: string;
	startSegment?: string;
	fromPhase?: string;
	depOverrides?: Record<string, string>;
}

export interface DagRunResult {
	runId: string;
	runDir: string;
	status: "completed" | "failed";
	segmentResults: Record<string, SegmentRunResult>;
}

export async function runDag(opts: DagRunOptions): Promise<DagRunResult> {
	const {
		registry,
		config,
		logger,
		rootDir,
		startSegment,
		fromPhase,
		depOverrides,
	} = opts;

	validateRegistry(registry);

	// Resolve identity from dep chain (or fall back to cui.yaml).
	const identity = await resolveIdentity({ config, depOverrides });

	// Build effective config with sealed identity — all downstream steps see
	// the resolved input/reference, not whatever cui.yaml currently says.
	const effectiveConfig: CuiConfig = {
		...config,
		input: identity.input,
		reference: identity.reference,
	};

	// Surface divergence so operators see when cui.yaml was overridden.
	const divergence = describeIdentityDivergence(identity, {
		input: config.input,
		reference: config.reference,
	});
	if (divergence) {
		console.log(`[identity] ${divergence}`);
	}

	const runId = generateRunId();
	const runDir = await createRunDir(rootDir, runId);
	const metrics = new MetricsWriter(runDir);
	const order = resolveOrder(registry, startSegment);
	const runState = createRunState({
		runId,
		segmentIds: order,
		identity,
		config: effectiveConfig,
		startSegment,
		depOverrides: depOverrides ?? {},
	});
	await writeRunState(runDir, runState);

	const outputs: Record<string, string> = { ...depOverrides };
	const results: Record<string, SegmentRunResult> = {};
	const pending = new Set(order);
	const completed = initCompleted(depOverrides);

	await executeDag(
		pending,
		completed,
		outputs,
		results,
		runState,
		runDir,
		registry,
		effectiveConfig,
		logger,
		metrics,
		startSegment,
		fromPhase,
		depOverrides,
	);

	return finalizeDag(runState, runDir, runId, results, metrics);
}

// --- Helpers ---

function validateRegistry(registry: SegmentRegistry): void {
	const errors = registry.validateDeps();
	if (errors.length > 0) {
		throw new Error(`DAG validation failed:\n${errors.join("\n")}`);
	}
}

function resolveOrder(
	registry: SegmentRegistry,
	startSegment?: string,
): string[] {
	const order = registry.topologicalOrder();
	if (!startSegment) return order;

	const idx = order.indexOf(startSegment);
	if (idx === -1) {
		throw new Error(
			`Segment "${startSegment}" not found. Available: ${order.join(", ")}`,
		);
	}
	return order.slice(idx);
}

function initCompleted(depOverrides?: Record<string, string>): Set<string> {
	const completed = new Set<string>();
	if (depOverrides) {
		for (const id of Object.keys(depOverrides)) {
			completed.add(id);
		}
	}
	return completed;
}

function findReadySegments(
	pending: Set<string>,
	completed: Set<string>,
	registry: SegmentRegistry,
	depOverrides?: Record<string, string>,
): string[] {
	const ready: string[] = [];
	for (const id of pending) {
		const seg = registry.get(id);
		const depsReady = seg.depends.every(
			(d) => completed.has(d) || (depOverrides && d in depOverrides),
		);
		if (depsReady) ready.push(id);
	}
	return ready;
}

async function executeBatch(
	ready: string[],
	runState: RunState,
	runDir: string,
	outputs: Record<string, string>,
	registry: SegmentRegistry,
	config: CuiConfig,
	logger: PipelineLogger,
	metrics: MetricsWriter,
	startSegment?: string,
	fromPhase?: string,
): Promise<Array<{ id: string; result: SegmentRunResult }>> {
	return Promise.all(
		ready.map(async (id) => {
			const seg = registry.get(id);
			runState.segments[id] = { status: "running" };
			await writeRunState(runDir, runState);

			const depOutputs: Record<string, string> = {};
			for (const dep of seg.depends) {
				if (outputs[dep]) depOutputs[dep] = outputs[dep];
			}

			const result = await runSegment({
				segment: seg,
				runId: runState.runId,
				runDir,
				depOutputs,
				fromPhase: id === startSegment ? fromPhase : undefined,
				config,
				logger,
				metrics,
			});

			return { id, result };
		}),
	);
}

function processBatchResults(
	batch: Array<{ id: string; result: SegmentRunResult }>,
	pending: Set<string>,
	completed: Set<string>,
	outputs: Record<string, string>,
	results: Record<string, SegmentRunResult>,
	runState: RunState,
	registry: SegmentRegistry,
): void {
	for (const { id, result } of batch) {
		results[id] = result;
		pending.delete(id);
		completed.add(id);

		if (result.status === "completed" && result.outputDir) {
			outputs[id] = result.outputDir;
			runState.segments[id] = {
				status: "completed",
				outputDir: result.outputDir,
			};
		} else {
			runState.segments[id] = { status: "failed" };
			skipDependents(id, pending, completed, runState, registry);
		}
	}
}

function skipDependents(
	failedId: string,
	pending: Set<string>,
	completed: Set<string>,
	runState: RunState,
	registry: SegmentRegistry,
): void {
	for (const pendingId of [...pending]) {
		const seg = registry.get(pendingId);
		if (seg.depends.includes(failedId)) {
			runState.segments[pendingId] = { status: "skipped" };
			pending.delete(pendingId);
			completed.add(pendingId);
		}
	}
}

async function executeDag(
	pending: Set<string>,
	completed: Set<string>,
	outputs: Record<string, string>,
	results: Record<string, SegmentRunResult>,
	runState: RunState,
	runDir: string,
	registry: SegmentRegistry,
	config: CuiConfig,
	logger: PipelineLogger,
	metrics: MetricsWriter,
	startSegment?: string,
	fromPhase?: string,
	depOverrides?: Record<string, string>,
): Promise<void> {
	while (pending.size > 0) {
		const ready = findReadySegments(pending, completed, registry, depOverrides);

		if (ready.length === 0) {
			throw new Error(
				`Deadlock: no segments ready but ${pending.size} pending: ${[...pending].join(", ")}`,
			);
		}

		const batch = await executeBatch(
			ready,
			runState,
			runDir,
			outputs,
			registry,
			config,
			logger,
			metrics,
			startSegment,
			fromPhase,
		);

		processBatchResults(
			batch,
			pending,
			completed,
			outputs,
			results,
			runState,
			registry,
		);
		await writeRunState(runDir, runState);
	}
}

async function finalizeDag(
	runState: RunState,
	runDir: string,
	runId: string,
	results: Record<string, SegmentRunResult>,
	metrics: MetricsWriter,
): Promise<DagRunResult> {
	const anyFailed = Object.values(results).some((r) => r.status === "failed");
	runState.status = anyFailed ? "failed" : "completed";
	runState.finishedAt = new Date().toISOString();
	await writeRunState(runDir, runState);

	// Read back segment metrics to build run summary
	const segMetrics = await readSegmentMetrics(runDir);
	metrics.record({
		kind: "run",
		ts: new Date().toISOString(),
		runId,
		status: runState.status,
		segments: Object.keys(results).length,
		steps: segMetrics.reduce((s, m) => s + m.steps, 0),
		turns: segMetrics.reduce((s, m) => s + m.turns, 0),
		inputTokens: segMetrics.reduce((s, m) => s + m.inputTokens, 0),
		outputTokens: segMetrics.reduce((s, m) => s + m.outputTokens, 0),
		cost: segMetrics.reduce((s, m) => s + m.cost, 0),
		duration: runState.startedAt
			? Date.now() - new Date(runState.startedAt).getTime()
			: 0,
	});

	return {
		runId,
		runDir,
		status: runState.status,
		segmentResults: results,
	};
}

async function readSegmentMetrics(runDir: string): Promise<
	Array<{
		steps: number;
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cost: number;
	}>
> {
	try {
		const { readMetrics } = await import("./metrics.js");
		const records = await readMetrics(runDir);
		return records.filter(
			(r): r is import("./metrics.js").SegmentMetric => r.kind === "segment",
		);
	} catch {
		return [];
	}
}

function generateRunId(): string {
	const now = new Date();
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
