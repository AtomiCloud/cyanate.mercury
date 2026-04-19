/**
 * Pipeline logger — Ink-backed TUI for interactive mode, verbose logs for
 * non-interactive.
 *
 * Multi-slot: every call to `startStep` returns a `StepHandle` that must be
 * passed to `updateTurn`/`completeStep`/`failStep`. Many steps can be in flight
 * concurrently (per-leaf LLM calls, parallel reviewers, fan-out workers).
 *
 * Queue depth (LLM calls waiting on the agent.ts semaphore) is polled via
 * `setQueueDepthProvider`.
 */

import { type Instance, render } from "ink";
import { createElement } from "react";
import {
	Dashboard,
	type DashboardProps,
	formatCost,
	formatDuration,
	formatTokens,
	type StepMeta,
	type StepView,
} from "./logger-ui.js";

export type { StepMeta } from "./logger-ui.js";

const SEGMENT_TOTAL = 4;

const MAX_NOTES = 20;

interface SegmentStats {
	steps: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	duration: number;
}

/**
 * Opaque handle returned by `startStep`. Pass it back to
 * `updateTurn`/`completeStep`/`failStep`/`skipStep` so concurrent steps don't
 * clobber each other.
 */
export interface StepHandle {
	readonly id: string;
}

export interface PipelineLogger {
	startStep(name: string, meta?: StepMeta): StepHandle;
	updateTurn(
		handle: StepHandle,
		turn: number,
		inputTokens: number,
		outputTokens: number,
	): void;
	completeStep(handle: StepHandle, cost?: number): void;
	failStep(handle: StepHandle, error: string): void;
	skipStep(handle: StepHandle): void;
	/** One-off info line — no lifecycle, just surfaces text in the UI/stderr. */
	note(message: string): void;
	/** Supplies the live queue depth (e.g. `() => semaphore.pending`). */
	setQueueDepthProvider(provider: () => number): void;
	startSegment(segmentId: string): void;
	finishSegment(
		segmentId: string,
		status: "completed" | "failed",
	): SegmentStats;
	flush(): void;
	destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPipelineLogger(opts: {
	interactive: boolean;
	runId?: string;
}): PipelineLogger {
	if (opts.interactive) return new InteractiveLogger(opts.runId);
	return new NonInteractiveLogger();
}

let stepIdCounter = 0;
function nextStepId(): string {
	stepIdCounter += 1;
	return `s${stepIdCounter}`;
}

// ---------------------------------------------------------------------------
// Non-interactive (verbose console)
// ---------------------------------------------------------------------------

interface ActiveEntry {
	id: string;
	name: string;
	startTime: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

class NonInteractiveLogger implements PipelineLogger {
	private active = new Map<string, ActiveEntry>();
	private stepCount = 0;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private queueDepthProvider: () => number = () => 0;

	// Segment-level accumulators
	private segStart = 0;
	private segSteps = 0;
	private segTurns = 0;
	private segInputTokens = 0;
	private segOutputTokens = 0;
	private segCost = 0;

	setQueueDepthProvider(provider: () => number): void {
		this.queueDepthProvider = provider;
	}

	startStep(name: string, _meta?: StepMeta): StepHandle {
		this.stepCount += 1;
		const id = nextStepId();
		const entry: ActiveEntry = {
			id,
			name,
			startTime: Date.now(),
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
		};
		this.active.set(id, entry);
		console.log(`  ▶ [${this.stepCount}] ${name}`);
		this.ensureHeartbeat();
		return { id };
	}

	private ensureHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			if (this.active.size === 0) {
				if (this.heartbeat) clearInterval(this.heartbeat);
				this.heartbeat = null;
				return;
			}
			const queued = this.queueDepthProvider();
			const totalIn = [...this.active.values()].reduce(
				(s, a) => s + a.inputTokens,
				0,
			);
			const totalOut = [...this.active.values()].reduce(
				(s, a) => s + a.outputTokens,
				0,
			);
			console.log(
				`  [heartbeat] in-flight ${this.active.size} · queued ${queued} · ` +
					`${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out`,
			);
		}, 30_000);
	}

	updateTurn(
		handle: StepHandle,
		turns: number,
		inputTokens: number,
		outputTokens: number,
	): void {
		const entry = this.active.get(handle.id);
		if (!entry) return;
		entry.turns = turns;
		entry.inputTokens = inputTokens;
		entry.outputTokens = outputTokens;
	}

	completeStep(handle: StepHandle, cost?: number): void {
		const entry = this.active.get(handle.id);
		if (!entry) return;
		if (cost !== undefined) entry.cost = cost;
		const duration = Date.now() - entry.startTime;
		console.log(
			`  ✓ [${entry.id}] ${entry.name}: ${entry.turns} turns, ` +
				`${formatTokens(entry.inputTokens)} in, ${formatTokens(entry.outputTokens)} out, ` +
				`${formatCost(entry.cost)}, ${formatDuration(duration)}`,
		);
		this.segSteps += 1;
		this.segTurns += entry.turns;
		this.segInputTokens += entry.inputTokens;
		this.segOutputTokens += entry.outputTokens;
		this.segCost += entry.cost;
		this.active.delete(handle.id);
	}

	failStep(handle: StepHandle, error: string): void {
		const entry = this.active.get(handle.id);
		if (!entry) return;
		const duration = Date.now() - entry.startTime;
		console.error(
			`  ✗ [${entry.id}] ${entry.name}: ${error} (${formatDuration(duration)})`,
		);
		this.segSteps += 1;
		this.active.delete(handle.id);
	}

	skipStep(handle: StepHandle): void {
		const entry = this.active.get(handle.id);
		if (!entry) return;
		console.log(`  – [${entry.id}] ${entry.name}`);
		this.active.delete(handle.id);
	}

	note(message: string): void {
		console.log(`  · ${message}`);
	}

	startSegment(segmentId: string): void {
		this.segStart = Date.now();
		this.segSteps = 0;
		this.segTurns = 0;
		this.segInputTokens = 0;
		this.segOutputTokens = 0;
		this.segCost = 0;
		console.log(`\n━━ segment: ${segmentId} ━━`);
	}

	finishSegment(
		segmentId: string,
		status: "completed" | "failed",
	): SegmentStats {
		const duration = Date.now() - this.segStart;
		const icon = status === "completed" ? "✓" : "✗";
		console.log(
			`━━ ${icon} ${segmentId}: ${this.segSteps} steps, ${this.segTurns} turns, ` +
				`${formatTokens(this.segInputTokens)} in / ${formatTokens(this.segOutputTokens)} out, ` +
				`${formatCost(this.segCost)}, ${formatDuration(duration)} ━━\n`,
		);
		return {
			steps: this.segSteps,
			turns: this.segTurns,
			inputTokens: this.segInputTokens,
			outputTokens: this.segOutputTokens,
			cost: this.segCost,
			duration,
		};
	}

	flush(): void {}
	destroy(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
	}
}

// ---------------------------------------------------------------------------
// Interactive (Ink-backed TUI dashboard)
// ---------------------------------------------------------------------------

class InteractiveLogger implements PipelineLogger {
	private completed: StepView[] = [];
	private active = new Map<string, StepView>();
	private notes: string[] = [];
	private instance: Instance;
	private queueDepthProvider: () => number = () => 0;

	// Segment-level accumulators
	private segStart = 0;
	private segSteps = 0;
	private segTurns = 0;
	private segInputTokens = 0;
	private segOutputTokens = 0;
	private segCost = 0;

	// Progress counters
	private segmentIndex = 0;
	private phaseIndex: number | null = null;
	private phaseTotal: number | null = null;
	private seenPhases = new Set<string>();
	private idleSince: number | null = Date.now();

	private liveTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private runId?: string) {
		this.instance = render(this.element());
		this.liveTimer = setInterval(() => this.rerender(), 1000);
	}

	setQueueDepthProvider(provider: () => number): void {
		this.queueDepthProvider = provider;
	}

	private element() {
		const totalCost = this.completed.reduce((sum, s) => sum + s.cost, 0);
		const totalSteps = this.completed.length;
		const queueDepth = this.queueDepthProvider();
		const activeList = [...this.active.values()].sort(
			(a, b) => a.startedAt - b.startedAt,
		);
		const isIdle = activeList.length === 0 && queueDepth === 0;
		const props: DashboardProps = {
			runId: this.runId,
			completed: this.completed,
			active: activeList,
			queueDepth,
			notes: this.notes,
			segmentIndex: this.segmentIndex,
			segmentTotal: SEGMENT_TOTAL,
			phaseIndex: this.phaseIndex,
			phaseTotal: this.phaseTotal,
			totalCost,
			totalSteps,
			idleSince: isIdle ? this.idleSince : null,
		};
		return createElement(Dashboard, props);
	}

	private rerender(): void {
		// Refresh each active step's duration so elapsed counters tick.
		const now = Date.now();
		for (const step of this.active.values()) {
			step.duration = now - step.startedAt;
		}
		this.instance.rerender(this.element());
	}

	/** Extract "segment/phase/..." prefix from a step label. */
	private trackPhase(name: string): void {
		const slash = name.indexOf("/");
		if (slash === -1) return;
		const segmentId = name.slice(0, slash);
		const rest = name.slice(slash + 1);
		const nextSlash = rest.indexOf("/");
		const phaseId =
			nextSlash === -1 ? rest.split(" ")[0] : rest.slice(0, nextSlash);
		if (!phaseId) return;
		const key = `${segmentId}/${phaseId}`;
		if (this.seenPhases.has(key)) return;
		this.seenPhases.add(key);
		this.phaseIndex = (this.phaseIndex ?? 0) + 1;
	}

	startStep(name: string, meta?: StepMeta): StepHandle {
		this.trackPhase(name);
		const id = nextStepId();
		const now = Date.now();
		this.idleSince = null;
		this.active.set(id, {
			id,
			name,
			status: "running",
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			duration: 0,
			startedAt: now,
			kind: meta?.kind,
			parallel: meta?.parallel,
		});
		this.rerender();
		return { id };
	}

	updateTurn(
		handle: StepHandle,
		turns: number,
		inputTokens: number,
		outputTokens: number,
	): void {
		const step = this.active.get(handle.id);
		if (!step) return;
		step.turns = turns;
		step.inputTokens = inputTokens;
		step.outputTokens = outputTokens;
		step.duration = Date.now() - step.startedAt;
		this.rerender();
	}

	completeStep(handle: StepHandle, cost?: number): void {
		const step = this.active.get(handle.id);
		if (!step) return;
		step.status = "completed";
		if (cost !== undefined) step.cost = cost;
		step.duration = Date.now() - step.startedAt;
		this.segSteps += 1;
		this.segTurns += step.turns;
		this.segInputTokens += step.inputTokens;
		this.segOutputTokens += step.outputTokens;
		this.segCost += step.cost;
		this.completed = [...this.completed, step];
		this.active.delete(handle.id);
		this.maybeMarkIdle();
		this.rerender();
	}

	failStep(handle: StepHandle, error: string): void {
		const step = this.active.get(handle.id);
		if (!step) return;
		step.status = "failed";
		step.error = error;
		step.duration = Date.now() - step.startedAt;
		this.segSteps += 1;
		this.completed = [...this.completed, step];
		this.active.delete(handle.id);
		this.maybeMarkIdle();
		this.rerender();
	}

	skipStep(handle: StepHandle): void {
		const step = this.active.get(handle.id);
		if (!step) return;
		step.status = "skipped";
		step.duration = 0;
		this.completed = [...this.completed, step];
		this.active.delete(handle.id);
		this.maybeMarkIdle();
		this.rerender();
	}

	note(message: string): void {
		this.notes = [...this.notes, message].slice(-MAX_NOTES);
		this.rerender();
	}

	private maybeMarkIdle(): void {
		if (this.active.size === 0) this.idleSince = Date.now();
	}

	startSegment(segmentId: string): void {
		this.segStart = Date.now();
		this.segSteps = 0;
		this.segTurns = 0;
		this.segInputTokens = 0;
		this.segOutputTokens = 0;
		this.segCost = 0;
		this.segmentIndex += 1;
		this.phaseIndex = null;
		this.phaseTotal = null;
		this.seenPhases.clear();
		this.note(`segment: ${segmentId}`);
	}

	finishSegment(
		segmentId: string,
		status: "completed" | "failed",
	): SegmentStats {
		const duration = Date.now() - this.segStart;
		const icon = status === "completed" ? "✓" : "✗";
		this.note(
			`${icon} ${segmentId}: ${this.segSteps} steps, ${formatCost(this.segCost)}, ${formatDuration(duration)}`,
		);
		return {
			steps: this.segSteps,
			turns: this.segTurns,
			inputTokens: this.segInputTokens,
			outputTokens: this.segOutputTokens,
			cost: this.segCost,
			duration,
		};
	}

	flush(): void {
		this.rerender();
	}

	destroy(): void {
		if (this.liveTimer) clearInterval(this.liveTimer);
		this.liveTimer = null;
		this.instance.unmount();
	}
}
