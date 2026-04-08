/**
 * Pipeline logger — TUI dashboard for interactive mode, verbose logs for non-interactive.
 */

const SPINNER_FRAMES = [
	"\u280B",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283C",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280F",
];

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
};

export interface PipelineLogger {
	startStep(name: string): void;
	updateTurn(turn: number, inputTokens: number, outputTokens: number): void;
	completeStep(cost?: number): void;
	failStep(error: string): void;
	skipStep(): void;
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
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatCompactTurnCount(turns: number): string {
	return turns === 1 ? "turn 1" : `turns ${turns}`;
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
// Non-interactive (verbose console)
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

class NonInteractiveLogger implements PipelineLogger {
	private currentStep = "";
	private startTime = 0;
	private turns = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private cost = 0;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private stepCount = 0;

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
		console.log(
			`  [turn ${turns}] [${this.stepCount}] ${this.currentStep}: ` +
				`${formatTokens(inputTokens)} in, ${formatTokens(outputTokens)} out`,
		);
	}

	completeStep(cost?: number): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (cost !== undefined) this.cost = cost;
		const duration = Date.now() - this.startTime;
		console.log(
			`  [done] [${this.stepCount}] ${this.currentStep}: ${this.turns} turns, ` +
				`${formatTokens(this.inputTokens)} in, ${formatTokens(this.outputTokens)} out, ` +
				`${formatCost(this.cost)}, ${formatDuration(duration)}`,
		);
	}

	failStep(error: string): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		const duration = Date.now() - this.startTime;
		console.error(
			`  [FAILED] [${this.stepCount}] ${this.currentStep}: ${error} (${formatDuration(duration)})`,
		);
	}

	skipStep(): void {
		console.log(`  [SKIP] [${this.stepCount}] ${this.currentStep}`);
	}

	flush(): void {}
	destroy(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
	}
}

// ---------------------------------------------------------------------------
// Interactive (TUI dashboard with ANSI cursor control)
// ---------------------------------------------------------------------------

class InteractiveLogger implements PipelineLogger {
	private steps: StepDisplay[] = [];
	private currentStep: StepDisplay | null = null;
	private startTime = 0;
	private spinnerFrame = 0;
	private spinnerInterval: ReturnType<typeof setInterval> | null = null;
	private linesUsed = 0;

	constructor(private runId?: string) {
		process.stdout.write(C.cursorHide);
	}

	startStep(name: string): void {
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

		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		this.spinnerInterval = setInterval(() => {
			if (!this.currentStep) return;
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.currentStep.duration = Date.now() - this.startTime;
			this.render();
		}, 100);

		this.render();
	}

	updateTurn(turns: number, inputTokens: number, outputTokens: number): void {
		if (!this.currentStep) return;
		this.currentStep.turns = turns;
		this.currentStep.inputTokens = inputTokens;
		this.currentStep.outputTokens = outputTokens;
		this.currentStep.duration = Date.now() - this.startTime;
		this.render();
	}

	completeStep(cost?: number): void {
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		if (!this.currentStep) return;
		this.currentStep.status = "completed";
		if (cost !== undefined) this.currentStep.cost = cost;
		this.currentStep.duration = Date.now() - this.startTime;
		this.steps.push(this.currentStep);
		this.currentStep = null;
		this.render();
	}

	failStep(error: string): void {
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		if (!this.currentStep) return;
		this.currentStep.status = "failed";
		this.currentStep.error = error;
		this.currentStep.duration = Date.now() - this.startTime;
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

	flush(): void {}

	destroy(): void {
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		if (this.currentStep) {
			this.currentStep.status = "completed";
			this.steps.push(this.currentStep);
			this.currentStep = null;
		}
		this.render();
		process.stdout.write(`${C.cursorShow}\n`);
	}

	private render(): void {
		const allSteps = [...this.steps];
		if (this.currentStep) allSteps.push(this.currentStep);

		const runningExtraLines = this.currentStep ? 1 : 0;
		const totalLines = 2 + allSteps.length + runningExtraLines + 1;

		if (this.linesUsed > 0) {
			process.stdout.write(C.moveUp(this.linesUsed));
		}

		// Clear everything below cursor
		process.stdout.write("\x1b[J");

		// Header
		if (this.runId) {
			process.stdout.write(`  ${C.bold}${C.dim}Run ${this.runId}${C.reset}\n`);
		} else {
			process.stdout.write("\n");
		}

		// Column headers
		process.stdout.write(
			`${C.bold}${C.dim}       NAME                                   STATUS / METRICS                        DURATION${C.reset}\n`,
		);

		// Step rows
		for (let i = 0; i < allSteps.length; i++) {
			const step = allSteps[i];
			this.renderStep(step, i);
		}

		// Footer: spinner or blank
		if (this.currentStep) {
			const elapsed = formatDuration(this.currentStep.duration);
			const spinner = SPINNER_FRAMES[this.spinnerFrame];
			const stepNum = this.steps.length + 1;
			process.stdout.write(
				`  ${C.yellow}${spinner}${C.reset}  ${C.dim}Running step ${stepNum}...  ${elapsed} elapsed${C.reset}\n`,
			);
		} else {
			process.stdout.write("\n");
		}

		this.linesUsed = totalLines + 1;
	}

	private renderStep(step: StepDisplay, index: number): void {
		const icon = this.statusIcon(step);
		const color = this.statusColor(step);
		const ordinal = `${pad(`${index + 1}`, 2, "right")}.`;
		const name = pad(step.name, 39);
		const duration = pad(formatDuration(step.duration), 10);

		if (step.status === "running") {
			process.stdout.write(
				`  ${color}${ordinal} ${icon}${C.reset}  ${name}${pad("running", 38)}${duration}\n`,
			);
			const metrics = `${formatCompactTurnCount(step.turns)}   ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)}   ${formatCost(step.cost)}`;
			process.stdout.write(`      ${C.dim}${metrics}${C.reset}\n`);
		} else {
			const status = this.formatStatus(step);
			process.stdout.write(
				`  ${color}${ordinal} ${icon}${C.reset}  ${name}${pad(status, 38)}${duration}\n`,
			);
		}
	}

	private formatStatus(step: StepDisplay): string {
		if (step.status === "completed") {
			return `${formatCompactTurnCount(step.turns)}   ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)}   ${formatCost(step.cost)}`;
		}
		if (step.status === "failed") {
			return (step.error ?? "failed").slice(0, 38);
		}
		return "skipped";
	}

	private statusIcon(step: StepDisplay): string {
		switch (step.status) {
			case "completed":
				return "\u2713";
			case "failed":
				return "\u2717";
			case "skipped":
				return "\u2013";
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
