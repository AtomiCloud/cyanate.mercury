/**
 * CLI entry point using Commander.js.
 *
 * Commands:
 *   mecury run                     Run the full pipeline
 *   mecury run --segment layout    Start from a specific segment
 *   mecury run --from classify     Start from a phase within the segment
 *   mecury run --dep analyze=path  Provide pre-computed dependency outputs
 *   mecury resume <run-dir>        Resume a failed run
 *   mecury list                    List registered segments and phases
 */

import { resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import type { DagRunResult } from "./engine/dag.js";
import { runDag } from "./engine/dag.js";
import { registry } from "./engine/registry.js";
import { readRunState } from "./engine/state.js";
import { currentQueueDepth } from "./lib/agent.js";
import { createPipelineLogger } from "./lib/logger.js";

const program = new Command()
	.name("mecury")
	.description("AI Website Regeneration Engine")
	.version("0.1.0");

// --- run command ---

program
	.command("run")
	.description("Run the pipeline")
	.option("--segment <id>", "Start from a specific segment")
	.option("--from <phase>", "Start from a specific phase within the segment")
	.option(
		"--dep <mapping...>",
		"Map dependency outputs (format: segmentId=path)",
	)
	.option("--input <path>", "Override cui.yaml input path")
	.option("--reference <url>", "Override cui.yaml reference URL")
	.option("--config <path>", "Path to cui.yaml", "cui.yaml")
	.option("--non-interactive", "Verbose logging mode", false)
	.action(async (opts) => {
		const config = loadConfig(opts.config);
		if (opts.input) config.input = opts.input;
		if (opts.reference) config.reference = opts.reference;
		const logger = createPipelineLogger({
			interactive: !opts.nonInteractive,
			runId: "pending",
		});
		logger.setQueueDepthProvider(currentQueueDepth);

		const depOverrides = parseDepFlags(opts.dep);
		await resolveInteractiveDeps(opts, depOverrides);

		const result = await runDag({
			registry,
			config,
			logger,
			rootDir: process.cwd(),
			startSegment: opts.segment,
			fromPhase: opts.from,
			depOverrides:
				Object.keys(depOverrides).length > 0 ? depOverrides : undefined,
		});

		reportResult(result);
		logger.destroy();
	});

// --- resume command ---

program
	.command("resume <run-dir>")
	.description("Resume a failed run from where it left off")
	.option("--config <path>", "Path to cui.yaml", "cui.yaml")
	.option("--non-interactive", "Verbose logging mode", false)
	.action(async (runDirArg, opts) => {
		const runDir = resolve(runDirArg);
		const runState = await readRunState(runDir);

		if (!runState) {
			console.error(chalk.red(`No run.json found in ${runDir}`));
			process.exit(1);
		}

		if (runState.status === "completed") {
			console.log(chalk.green("Run already completed."));
			return;
		}

		const failedSegment = Object.entries(runState.segments).find(
			([_, s]) => s.status === "failed",
		);

		if (!failedSegment) {
			console.error(chalk.red("No failed segments to resume."));
			process.exit(1);
		}

		// Prefer the exact config the prior run used (post-identity-inheritance,
		// with LLM profiles / heartbeat / reviewer_matrix etc. frozen at run
		// start). Fall back to cui.yaml + identity override for legacy runs
		// that predate RunState.config.
		const effectiveConfig = runState.config
			? runState.config
			: runState.identity
				? {
						...loadConfig(opts.config),
						input: runState.identity.input,
						reference: runState.identity.reference,
					}
				: loadConfig(opts.config);

		const logger = createPipelineLogger({
			interactive: !opts.nonInteractive,
			runId: runState.runId,
		});
		logger.setQueueDepthProvider(currentQueueDepth);

		// Rebuild dep map: completed segments from this run + any --dep
		// overrides from the original launch (for cross-run deps).
		const depOverrides: Record<string, string> = {
			...(runState.depOverrides ?? {}),
		};
		for (const [id, s] of Object.entries(runState.segments)) {
			if (s.status === "completed" && s.outputDir) {
				depOverrides[id] = s.outputDir;
			}
		}

		const result = await runDag({
			registry,
			config: effectiveConfig,
			logger,
			rootDir: resolve(runDir, ".."),
			startSegment: failedSegment[0],
			depOverrides,
		});

		reportResult(result);
		logger.destroy();
	});

// --- list command ---

program
	.command("list")
	.description("List registered segments and their phases")
	.action(() => {
		const segments = registry.list();
		if (segments.length === 0) {
			console.log(chalk.yellow("No segments registered."));
			return;
		}

		for (const seg of segments) {
			const deps =
				seg.depends.length > 0
					? chalk.dim(` (depends: ${seg.depends.join(", ")})`)
					: "";
			console.log(`${chalk.bold(seg.id)}${deps}`);
			console.log(`  ${seg.description}`);
			for (const phase of seg.phases) {
				console.log(
					`  ${chalk.cyan(phase.id)} — ${phase.name} (${phase.steps.length} steps, max ${phase.maxRetries} retries)`,
				);
			}
			console.log();
		}
	});

// --- metrics command ---

program
	.command("metrics")
	.description("Query pipeline metrics from a run")
	.argument("[query]", "PromQL-esque query, e.g. 'avg by (segment, phase)'")
	.option("--run <id>", "Run ID to query (default: latest)")
	.option("--kind <kind>", "Record kind: step, segment, run", "step")
	.action(async (queryStr: string | undefined, opts) => {
		const { readMetrics } = await import("./engine/metrics.js");
		const { executeQuery, formatTable, parseQuery } = await import(
			"./engine/metrics-query.js"
		);

		const runDir = await resolveRunDir(opts.run);
		if (!runDir) {
			console.error(chalk.red("No runs found. Run the pipeline first."));
			process.exit(1);
		}

		const allRecords = await readMetrics(runDir);
		const kindFilter = opts.kind as string;
		const records = allRecords.filter((r) => r.kind === kindFilter);

		if (records.length === 0) {
			console.log(chalk.yellow(`No ${kindFilter} records found in ${runDir}`));
			return;
		}

		if (!queryStr) {
			// No query — show raw table of all records
			const { formatTable: fmt } = await import("./engine/metrics-query.js");
			// Build flat rows from records
			const rows = records.map((r) => {
				const row: Record<string, string | number> = {};
				for (const [k, v] of Object.entries(r)) {
					if (k === "kind" || k === "ts") continue;
					row[k] = v as string | number;
				}
				return row;
			});
			console.log(fmt(rows));
			return;
		}

		// Parse and execute query (only step metrics support full aggregation)
		if (kindFilter !== "step") {
			console.error(
				chalk.red("Aggregation queries only work with --kind step (default)"),
			);
			process.exit(1);
		}

		const parsed = parseQuery(queryStr);
		const result = executeQuery(
			records as import("./engine/metrics.js").StepMetric[],
			parsed,
		);
		console.log(formatTable(result));
	});

// --- check command ---

const check = program
	.command("check")
	.description("Self-verification CLIs the pipeline agents can invoke");

check
	.command("normalization <unit-dir>")
	.description(
		"Verify a per-page A0 normalization artifact against its source content.json",
	)
	.action(async (unitDirArg: string) => {
		const unitDir = resolve(unitDirArg);
		const { checkNormalizationCli } = await import(
			"./segments/classify/check-cli.js"
		);
		const exitCode = await checkNormalizationCli(unitDir);
		process.exit(exitCode);
	});

// --- Helpers ---

function parseDepFlags(deps?: string[]): Record<string, string> {
	const overrides: Record<string, string> = {};
	if (!deps) return overrides;

	for (const d of deps) {
		const [key, ...rest] = d.split("=");
		const val = rest.join("=");
		if (!key || !val) {
			console.error(
				chalk.red(`Invalid --dep format: "${d}". Use: segmentId=path`),
			);
			process.exit(1);
		}
		overrides[key] = resolve(val);
	}
	return overrides;
}

async function resolveInteractiveDeps(
	opts: { nonInteractive?: boolean; segment?: string },
	depOverrides: Record<string, string>,
): Promise<void> {
	if (opts.nonInteractive || !opts.segment || !registry.has(opts.segment))
		return;

	const seg = registry.get(opts.segment);
	const missingDeps = seg.depends.filter((d: string) => !(d in depOverrides));
	if (missingDeps.length === 0) return;

	const { selectDependencies } = await import("./lib/dep-selector.js");
	const selected = await selectDependencies(
		process.cwd(),
		opts.segment,
		registry,
		missingDeps,
	);
	Object.assign(depOverrides, selected);
}

async function resolveRunDir(runId?: string): Promise<string | null> {
	const { readdir } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const runsDir = resolve("runs");
	try {
		const entries = await readdir(runsDir);
		if (entries.length === 0) return null;
		if (runId) {
			const match = entries.find((e) => e === runId || e.includes(runId));
			return match ? join(runsDir, match) : null;
		}
		// Latest: sort descending, take first
		const sorted = entries.sort().reverse();
		return join(runsDir, sorted[0]);
	} catch {
		return null;
	}
}

function reportResult(result: DagRunResult): void {
	if (result.status === "completed") {
		console.log(chalk.green(`\nRun completed: ${result.runDir}`));
	} else {
		console.error(chalk.red(`\nRun failed: ${result.runDir}`));
		for (const [id, r] of Object.entries(result.segmentResults)) {
			if (r.status === "failed") {
				console.error(chalk.red(`  ${id}: ${r.error}`));
			}
		}
		process.exit(1);
	}
}

export { program };
