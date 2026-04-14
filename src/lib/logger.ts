/**
 * Pipeline logger — TUI dashboard for interactive mode, verbose logs for non-interactive.
 */

// ANSI escape codes
const C = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	gray: "\x1b[90m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	clearLine: "\x1b[2K",
	moveUp: (n: number) => `\x1b[${n}A`,
	cursorHide: "\x1b[?25l",
	cursorShow: "\x1b[?25h",
	eraseDown: "\x1b[J",
};

export interface SegmentStats {
	steps: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	duration: number;
}

export interface PipelineLogger {
	startStep(name: string): void;
	updateTurn(turn: number, inputTokens: number, outputTokens: number): void;
	completeStep(cost?: number): void;
	failStep(error: string): void;
	skipStep(): void;
	/** Start tracking stats for a new segment. */
	startSegment(segmentId: string): void;
	/** Print accumulated segment stats and reset counters. */
	finishSegment(
		segmentId: string,
		status: "completed" | "failed",
	): SegmentStats;
	flush(): void;
	destroy(): void;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatCost(usd: number): string {
	if (usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = Math.floor(secs / 60);
	const rem = Math.round(secs % 60);
	return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function pad(
	s: string,
	width: number,
	align: "left" | "right" = "left",
): string {
	const str = String(s);
	if (str.length >= width) return str.slice(0, width);
	const p = " ".repeat(width - str.length);
	return align === "left" ? str + p : p + str;
}

function truncate(s: string, width: number): string {
	return s.length > width ? `${s.slice(0, width - 1)}…` : s;
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

// ---------------------------------------------------------------------------
// Step display state
// ---------------------------------------------------------------------------

interface StepDisplay {
	name: string;
	status: "running" | "completed" | "failed" | "skipped";
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	duration: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Non-interactive (verbose console)
// ---------------------------------------------------------------------------

class NonInteractiveLogger implements PipelineLogger {
	private currentStep = "";
	private startTime = 0;
	private turns = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private cost = 0;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private stepCount = 0;

	// Segment-level accumulators
	private segStart = 0;
	private segSteps = 0;
	private segTurns = 0;
	private segInputTokens = 0;
	private segOutputTokens = 0;
	private segCost = 0;

	startStep(name: string): void {
		this.stepCount++;
		this.currentStep = name;
		this.startTime = Date.now();
		this.turns = 0;
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.cost = 0;

		this.heartbeat = setInterval(() => {
			const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
			console.log(
				`  [heartbeat] [${this.stepCount}] ${this.currentStep}: turn ${this.turns}, ` +
					`${formatTokens(this.inputTokens)} in / ${formatTokens(this.outputTokens)} out, ` +
					`${formatCost(this.cost)}, ${elapsed}s`,
			);
		}, 30000);
	}

	updateTurn(turns: number, inputTokens: number, outputTokens: number): void {
		this.turns = turns;
		this.inputTokens = inputTokens;
		this.outputTokens = outputTokens;
	}

	completeStep(cost?: number): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (cost !== undefined) this.cost = cost;
		const duration = Date.now() - this.startTime;
		console.log(
			`  ✓ [${this.stepCount}] ${this.currentStep}: ${this.turns} turns, ` +
				`${formatTokens(this.inputTokens)} in, ${formatTokens(this.outputTokens)} out, ` +
				`${formatCost(this.cost)}, ${formatDuration(duration)}`,
		);
		// Accumulate into segment totals
		this.segSteps++;
		this.segTurns += this.turns;
		this.segInputTokens += this.inputTokens;
		this.segOutputTokens += this.outputTokens;
		this.segCost += this.cost;
	}

	failStep(error: string): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		const duration = Date.now() - this.startTime;
		console.error(
			`  ✗ [${this.stepCount}] ${this.currentStep}: ${error} (${formatDuration(duration)})`,
		);
		this.segSteps++;
	}

	skipStep(): void {
		console.log(`  – [${this.stepCount}] ${this.currentStep}`);
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
	}
}

// ---------------------------------------------------------------------------
// Interactive (TUI dashboard with ANSI cursor control)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Count newline characters in a write chunk. */
function countNewlines(chunk: unknown): number {
	if (typeof chunk === "string") {
		let n = 0;
		for (let i = 0; i < chunk.length; i++) {
			if (chunk.charCodeAt(i) === 10) n++;
		}
		return n;
	}
	if (Buffer.isBuffer(chunk)) {
		let n = 0;
		for (let i = 0; i < chunk.length; i++) {
			if (chunk[i] === 10) n++;
		}
		return n;
	}
	return 0;
}

class InteractiveLogger implements PipelineLogger {
	private steps: StepDisplay[] = [];
	private currentStep: StepDisplay | null = null;
	private startTime = 0;
	private spinnerFrame = 0;
	private spinnerInterval: ReturnType<typeof setInterval> | null = null;
	private linesUsed = 0;
	private renderScheduled = false;
	/** Lines written to stdout/stderr by external code between renders. */
	private extraLines = 0;
	/** True while render() is executing — suppresses external line counting. */
	private rendering = false;
	private origStdoutWrite: typeof process.stdout.write;
	private origStderrWrite: typeof process.stderr.write;

	// Segment-level accumulators
	private segStart = 0;
	private segSteps = 0;
	private segTurns = 0;
	private segInputTokens = 0;
	private segOutputTokens = 0;
	private segCost = 0;

	constructor(private runId?: string) {
		// Intercept stdout/stderr so we can track lines written by external
		// code (agent SDK, console.warn, etc.) that shift the cursor down.
		this.origStdoutWrite = process.stdout.write.bind(process.stdout);
		this.origStderrWrite = process.stderr.write.bind(process.stderr);

		const boundOut = this.origStdoutWrite;
		const boundErr = this.origStderrWrite;

		process.stdout.write = ((
			chunk: Uint8Array | string,
			...args: unknown[]
		) => {
			if (!this.rendering) this.extraLines += countNewlines(chunk);
			return (boundOut as (...a: unknown[]) => boolean)(chunk, ...args);
		}) as typeof process.stdout.write;

		process.stderr.write = ((
			chunk: Uint8Array | string,
			...args: unknown[]
		) => {
			if (!this.rendering) this.extraLines += countNewlines(chunk);
			return (boundErr as (...a: unknown[]) => boolean)(chunk, ...args);
		}) as typeof process.stderr.write;

		process.stdout.write(C.cursorHide);
	}

	startStep(name: string): void {
		// Finalize previous running step
		if (this.currentStep?.status === "running") {
			this.currentStep.status = "completed";
			this.steps.push(this.currentStep);
		}

		this.startTime = Date.now();
		this.currentStep = {
			name,
			status: "running",
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			duration: 0,
		};

		// Only one spinner interval — restart if already running
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		this.spinnerInterval = setInterval(() => {
			if (!this.currentStep) return;
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.currentStep.duration = Date.now() - this.startTime;
			this.scheduleRender();
		}, 200);

		this.render();
	}

	updateTurn(
		_turns: number,
		_inputTokens: number,
		_outputTokens: number,
	): void {
		if (!this.currentStep) return;
		this.currentStep.turns = _turns;
		this.currentStep.inputTokens = _inputTokens;
		this.currentStep.outputTokens = _outputTokens;
		this.currentStep.duration = Date.now() - this.startTime;
		this.scheduleRender();
	}

	completeStep(cost?: number): void {
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		this.spinnerInterval = null;
		if (!this.currentStep) return;
		this.currentStep.status = "completed";
		if (cost !== undefined) this.currentStep.cost = cost;
		this.currentStep.duration = Date.now() - this.startTime;
		// Accumulate into segment totals
		this.segSteps++;
		this.segTurns += this.currentStep.turns;
		this.segInputTokens += this.currentStep.inputTokens;
		this.segOutputTokens += this.currentStep.outputTokens;
		this.segCost += this.currentStep.cost;
		this.steps.push(this.currentStep);
		this.currentStep = null;
		this.render();
	}

	failStep(error: string): void {
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		this.spinnerInterval = null;
		if (!this.currentStep) return;
		this.currentStep.status = "failed";
		this.currentStep.error = error;
		this.currentStep.duration = Date.now() - this.startTime;
		this.segSteps++;
		this.steps.push(this.currentStep);
		this.currentStep = null;
		this.render();
	}

	skipStep(): void {
		if (this.currentStep) {
			this.currentStep.status = "skipped";
			this.currentStep.duration = 0;
			this.steps.push(this.currentStep);
			this.currentStep = null;
			this.render();
		}
	}

	startSegment(_segmentId: string): void {
		this.segStart = Date.now();
		this.segSteps = 0;
		this.segTurns = 0;
		this.segInputTokens = 0;
		this.segOutputTokens = 0;
		this.segCost = 0;
	}

	finishSegment(
		segmentId: string,
		status: "completed" | "failed",
	): SegmentStats {
		const duration = Date.now() - this.segStart;
		// In interactive mode, just push a summary step row
		const icon = status === "completed" ? "✓" : "✗";
		this.steps.push({
			name: `${icon} ${segmentId} summary`,
			status: status === "completed" ? "completed" : "failed",
			turns: this.segTurns,
			inputTokens: this.segInputTokens,
			outputTokens: this.segOutputTokens,
			cost: this.segCost,
			duration,
		});
		this.render();
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
		this.render();
	}

	destroy(): void {
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		this.spinnerInterval = null;
		if (this.currentStep) {
			this.currentStep.status = "completed";
			this.currentStep.duration = Date.now() - this.startTime;
			this.steps.push(this.currentStep);
			this.currentStep = null;
		}
		this.render();
		// Restore original write functions before final write
		process.stdout.write = this.origStdoutWrite;
		process.stderr.write = this.origStderrWrite;
		process.stdout.write(`${C.cursorShow}\n`);
	}

	// --- Render scheduling ---
	// Batch renders: if updateTurn fires rapidly, only render once per frame.

	private scheduleRender(): void {
		if (this.renderScheduled) return;
		this.renderScheduled = true;
		// Use setImmediate to batch multiple updates within a single tick
		setImmediate(() => {
			this.renderScheduled = false;
			this.render();
		});
	}

	// --- Render ---

	private render(): void {
		this.rendering = true;

		const allSteps = [...this.steps];
		if (this.currentStep) allSteps.push(this.currentStep);

		// How many lines the running step block takes (header + metrics sub-line)
		const runningLines = this.currentStep ? 2 : 0;
		// Header (run ID) + column header + steps + running block
		const totalLines = 1 + 1 + allSteps.length + runningLines;

		// Move cursor up to overwrite previous render + any external output
		const moveBy = this.linesUsed + this.extraLines;
		this.extraLines = 0;
		if (moveBy > 0) {
			process.stdout.write(C.moveUp(moveBy));
		}

		// Clear everything below cursor
		process.stdout.write(C.eraseDown);

		// Header
		if (this.runId) {
			process.stdout.write(
				`  ${C.bold}${C.dim}mecury ${this.runId}${C.reset}\n`,
			);
		} else {
			process.stdout.write("\n");
		}

		// Column headers
		process.stdout.write(
			`  ${C.dim}  #  NAME                                    STATUS                             ELAPSED${C.reset}\n`,
		);

		// Step rows
		for (let i = 0; i < allSteps.length; i++) {
			this.renderStepRow(allSteps[i], i);
		}

		// Running step: spinner + metrics
		if (this.currentStep) {
			const stepNum = this.steps.length + 1;
			const spinner = SPINNER_FRAMES[this.spinnerFrame];
			const elapsed = formatDuration(this.currentStep.duration);
			process.stdout.write(
				`  ${C.yellow}${spinner}${C.reset}  ${C.dim}step ${stepNum} of ?${C.reset}  ${elapsed} elapsed\n`,
			);
			const metrics = `    ${C.dim}turn ${this.currentStep.turns}  ·  ${formatTokens(this.currentStep.inputTokens)} in  ${formatTokens(this.currentStep.outputTokens)} out  ·  ${formatCost(this.currentStep.cost)}${C.reset}`;
			process.stdout.write(`${metrics}\n`);
		}

		this.linesUsed = totalLines;
		this.rendering = false;
	}

	private renderStepRow(step: StepDisplay, index: number): void {
		const icon = this.statusIcon(step);
		const color = this.statusColor(step);
		const ordinal = pad(`${index + 1}`, 3, "right");
		const name = pad(truncate(step.name, 40), 40);
		const elapsed = pad(formatDuration(step.duration), 8);

		if (step.status === "completed") {
			const detail = `${step.turns}t · ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)} · ${formatCost(step.cost)}`;
			process.stdout.write(
				`  ${color}${icon}${C.reset}  ${C.dim}${ordinal}${C.reset}  ${name}  ${pad(truncate(detail, 33), 33)}${C.dim}${elapsed}${C.reset}\n`,
			);
		} else if (step.status === "failed") {
			const err = step.error ? truncate(step.error, 33) : "failed";
			process.stdout.write(
				`  ${color}${icon}${C.reset}  ${C.dim}${ordinal}${C.reset}  ${name}  ${C.red}${pad(err, 33)}${C.reset}${C.dim}${elapsed}${C.reset}\n`,
			);
		} else if (step.status === "skipped") {
			process.stdout.write(
				`  ${color}${icon}${C.reset}  ${C.dim}${ordinal}${C.reset}  ${C.dim}${name}  ${pad("skipped", 33)}${elapsed}${C.reset}\n`,
			);
		} else {
			// running
			const detail = `${step.turns}t · ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)} · ${formatCost(step.cost)}`;
			process.stdout.write(
				`  ${color}${icon}${C.reset}  ${C.dim}${ordinal}${C.reset}  ${name}  ${pad(truncate(detail, 33), 33)}${C.dim}${elapsed}${C.reset}\n`,
			);
		}
	}

	private statusIcon(step: StepDisplay): string {
		switch (step.status) {
			case "completed":
				return "✓";
			case "failed":
				return "✗";
			case "skipped":
				return "–";
			case "running":
				return SPINNER_FRAMES[this.spinnerFrame];
		}
	}

	private statusColor(step: StepDisplay): string {
		switch (step.status) {
			case "completed":
				return C.green;
			case "failed":
				return C.red;
			case "skipped":
				return C.gray;
			case "running":
				return C.yellow;
		}
	}
}
