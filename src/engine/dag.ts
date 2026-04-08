/**
 * DAG executor for segments.
 *
 * Segments form a DAG via their `depends` fields.
 * Independent segments run in parallel; dependent segments wait.
 */

import type { PipelineLogger } from "../lib/logger.js";
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

	const runId = generateRunId();
	const runDir = await createRunDir(rootDir, runId);
	const order = resolveOrder(registry, startSegment);
	const runState = createRunState(runId, order);
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
		config,
		logger,
		startSegment,
		fromPhase,
		depOverrides,
	);

	return finalizeDag(runState, runDir, runId, results);
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
): Promise<DagRunResult> {
	const anyFailed = Object.values(results).some((r) => r.status === "failed");
	runState.status = anyFailed ? "failed" : "completed";
	runState.finishedAt = new Date().toISOString();
	await writeRunState(runDir, runState);

	return {
		runId,
		runDir,
		status: runState.status,
		segmentResults: results,
	};
}

function generateRunId(): string {
	const now = new Date();
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
