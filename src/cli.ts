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
	.option("--config <path>", "Path to cui.yaml", "cui.yaml")
	.option("--non-interactive", "Verbose logging mode", false)
	.action(async (opts) => {
		const config = loadConfig(opts.config);
		const logger = createPipelineLogger({
			interactive: !opts.nonInteractive,
			runId: "pending",
		});

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

		const config = loadConfig(opts.config);
		const logger = createPipelineLogger({
			interactive: !opts.nonInteractive,
			runId: runState.runId,
		});

		const depOverrides: Record<string, string> = {};
		for (const [id, s] of Object.entries(runState.segments)) {
			if (s.status === "completed" && s.outputDir) {
				depOverrides[id] = s.outputDir;
			}
		}

		const result = await runDag({
			registry,
			config,
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
