/**
 * Pipeline logger — TUI dashboard for interactive mode, verbose logs for non-interactive.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ANSI colors
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  clearLine: '\x1b[2K',
  moveUp: (n: number) => `\x1b[${n}A`,
  moveDown: (n: number) => `\x1b[${n}B`,
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
};

export interface StepResult {
  name: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  error?: string;
}

export interface PipelineLogger {
  startStep(name: string): void;
  updateTurn(turns: number, inputTokens: number, outputTokens: number, cost?: number): void;
  completeStep(cost: number): void;
  failStep(error: string): void;
  skipStep(): void;
  flush(): void;
  destroy(): void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCompactTurnCount(turns: number): string {
  return turns === 1 ? 'turn 1' : `turns ${turns}`;
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const str = String(s);
  if (str.length >= width) return str.slice(0, width);
  const pad = ' '.repeat(width - str.length);
  return align === 'left' ? str + pad : pad + str;
}

export function createPipelineLogger(opts: { interactive: boolean; runId?: string }): PipelineLogger {
  if (opts.interactive) return new InteractiveLogger(opts.runId);
  return new NonInteractiveLogger(opts.runId);
}

class NonInteractiveLogger implements PipelineLogger {
  private currentStep = '';
  private startTime = 0;
  private turns = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cost = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stepCount = 0;

  constructor(private runId?: string) {}

  startStep(name: string): void {
    this.stepCount++;
    this.currentStep = name;
    this.startTime = Date.now();
    this.turns = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cost = 0;

    // Heartbeat every 30s
    this.heartbeat = setInterval(() => {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
      console.log(
        `  [heartbeat] [${this.stepCount}] ${this.currentStep}: turn ${this.turns}, ` +
        `${formatTokens(this.inputTokens)} in / ${formatTokens(this.outputTokens)} out, ` +
        `${formatCost(this.cost)}, ${elapsed}s`,
      );
    }, 30000);
  }

  updateTurn(turns: number, inputTokens: number, outputTokens: number, cost?: number): void {
    this.turns = turns;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    if (cost !== undefined) this.cost = cost;
    console.log(
      `  [turn ${turns}] [${this.stepCount}] ${this.currentStep}: ` +
      `${formatTokens(inputTokens)} in, ${formatTokens(outputTokens)} out ` +
      `(total: ${formatTokens(this.inputTokens)} / ${formatTokens(this.outputTokens)})`,
    );
  }

  completeStep(cost: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.cost = cost;
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
    console.error(`  [FAILED] [${this.stepCount}] ${this.currentStep}: ${error} (${formatDuration(duration)})`);
  }

  skipStep(): void {
    console.log(`  [SKIP] [${this.stepCount}] ${this.currentStep}`);
  }

  flush(): void {}
  destroy(): void {}
}

class InteractiveLogger implements PipelineLogger {
  private steps: StepResult[] = [];
  private currentStep: StepResult | null = null;
  private startTime = 0;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private linesUsed = 0;

  constructor(private runId?: string) {}

  startStep(name: string): void {
    // Finalize previous step if running
    if (this.currentStep && this.currentStep.status === 'running') {
      this.currentStep.status = 'completed';
    }

    this.startTime = Date.now();
    this.currentStep = {
      name,
      status: 'running',
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      duration: 0,
    };

    // Start spinner animation
    if (this.spinnerInterval) clearInterval(this.spinnerInterval);
    this.spinnerInterval = setInterval(() => {
      if (!this.currentStep) return;
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.currentStep.duration = Date.now() - this.startTime;
      this.render();
    }, 100);

    this.render();
  }

  updateTurn(turns: number, inputTokens: number, outputTokens: number, cost?: number): void {
    if (!this.currentStep) return;
    this.currentStep.turns = turns;
    this.currentStep.inputTokens = inputTokens;
    this.currentStep.outputTokens = outputTokens;
    if (cost !== undefined) this.currentStep.cost = cost;
    this.currentStep.duration = Date.now() - this.startTime;
    this.render();
  }

  completeStep(cost: number): void {
    if (this.spinnerInterval) clearInterval(this.spinnerInterval);
    if (!this.currentStep) return;
    this.currentStep.status = 'completed';
    this.currentStep.cost = cost;
    this.currentStep.duration = Date.now() - this.startTime;
    this.steps.push(this.currentStep);
    this.currentStep = null;
    this.render();
  }

  failStep(error: string): void {
    if (this.spinnerInterval) clearInterval(this.spinnerInterval);
    if (!this.currentStep) return;
    this.currentStep.status = 'failed';
    this.currentStep.error = error;
    this.currentStep.duration = Date.now() - this.startTime;
    this.steps.push(this.currentStep);
    this.currentStep = null;
    this.render();
  }

  skipStep(): void {
    if (this.currentStep) {
      this.currentStep.status = 'skipped';
      this.currentStep.duration = 0;
      this.steps.push(this.currentStep);
      this.currentStep = null;
      this.render();
    }
  }

  flush(): void {
    // No-op: render handles output
  }

  destroy(): void {
    if (this.spinnerInterval) clearInterval(this.spinnerInterval);
    if (this.currentStep) {
      this.currentStep.status = 'completed';
      this.steps.push(this.currentStep);
      this.currentStep = null;
    }
    // Move past the dashboard so subsequent output doesn't overwrite it
    process.stdout.write(`\n`);
  }

  private render(): void {
    const allSteps = [...this.steps];
    if (this.currentStep) allSteps.push(this.currentStep);

    const runningExtraLines = this.currentStep ? 1 : 0;
    const totalLines = 2 + allSteps.length + runningExtraLines + 1;

    if (this.linesUsed > 0) {
      process.stdout.write(C.moveUp(this.linesUsed));
    }

    process.stdout.write('\x1b[J');

    if (this.runId) {
      process.stdout.write(`  ${C.bold}${C.dim}Run ${this.runId}${C.reset}\n`);
    } else {
      process.stdout.write('\n');
    }

    process.stdout.write(
      `${C.bold}${C.dim}       NAME                                   STATUS / METRICS                        DURATION${C.reset}\n`,
    );

    for (let i = 0; i < allSteps.length; i++) {
      const step = allSteps[i];
      const icon = this.statusIcon(step);
      const color = this.statusColor(step);
      const ordinal = pad(`${i + 1}`, 2, 'right') + '.';
      const name = pad(step.name, 39);
      const duration = pad(formatDuration(step.duration), 10);

      if (step.status === 'running') {
        process.stdout.write(`  ${color}${ordinal} ${icon}${C.reset}  ${name}${pad('running', 38)}${duration}\n`);
        const metrics = `${formatCompactTurnCount(step.turns)}   ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)}   ${formatCost(step.cost)}`;
        process.stdout.write(`      ${C.dim}${metrics}${C.reset}\n`);
      } else {
        const status = step.status === 'completed'
          ? `${formatCompactTurnCount(step.turns)}   ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)}   ${formatCost(step.cost)}`
          : step.status === 'failed'
            ? (step.error || 'failed').slice(0, 38)
            : 'skipped';
        process.stdout.write(`  ${color}${ordinal} ${icon}${C.reset}  ${name}${pad(status, 38)}${duration}\n`);
      }
    }

    if (this.currentStep) {
      const elapsed = formatDuration(this.currentStep.duration);
      const spinner = SPINNER_FRAMES[this.spinnerFrame];
      const stepNum = this.steps.length + 1;
      process.stdout.write(
        `  ${C.yellow}${spinner}${C.reset}  ${C.dim}Running step ${stepNum}...  ${elapsed} elapsed${C.reset}\n`,
      );
    } else {
      process.stdout.write(`\n`);
    }

    this.linesUsed = totalLines + 1;
  }

  private statusIcon(step: StepResult): string {
    switch (step.status) {
      case 'completed': return '✓';
      case 'failed': return '✗';
      case 'skipped': return '–';
      case 'running': return SPINNER_FRAMES[this.spinnerFrame];
    }
  }

  private statusColor(step: StepResult): string {
    switch (step.status) {
      case 'completed': return C.green;
      case 'failed': return C.red;
      case 'skipped': return C.gray;
      case 'running': return C.yellow;
    }
  }
}
