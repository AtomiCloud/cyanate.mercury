/**
 * Interactive dependency selector.
 *
 * Scans runs/ for existing completed segment outputs, presents
 * an interactive search prompt for each required dependency.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { search } from "@inquirer/prompts";
import chalk from "chalk";
import type { SegmentRegistry } from "../engine/registry.js";
import { readRunState } from "../engine/state.js";
import type { RunIdentity } from "../engine/types.js";

/**
 * Interactively select dependency outputs for a segment.
 *
 * @param rootDir - Project root (where runs/ lives)
 * @param segmentId - The segment that needs dependencies
 * @param reg - Segment registry for looking up depends
 * @param missingDeps - Only prompt for these specific dep IDs
 * @returns Mapping of dep segment ID → output directory path
 */
export async function selectDependencies(
	rootDir: string,
	segmentId: string,
	_reg: SegmentRegistry,
	missingDeps: string[],
): Promise<Record<string, string>> {
	const runsDir = join(rootDir, "runs");

	// Scan for existing runs
	let runDirs: string[];
	try {
		const entries = await readdir(runsDir);
		runDirs = entries
			.filter((e) => /^\d{8}-\d{6}$/.test(e))
			.sort()
			.reverse(); // most recent first
	} catch {
		throw new Error(
			`No runs/ directory found at ${runsDir}. Run the full pipeline first to generate dependency outputs.`,
		);
	}

	if (runDirs.length === 0) {
		throw new Error(
			"No runs found. Run the full pipeline first to generate dependency outputs.",
		);
	}

	// Load all run states
	const runs = await loadRunStates(runsDir, runDirs);

	const selected: Record<string, string> = {};

	for (const depId of missingDeps) {
		const choices = buildChoices(runs, depId);

		if (choices.length === 0) {
			throw new Error(
				`No completed runs found for segment "${depId}". ` +
					`Run it first or provide --dep ${depId}=<path>.`,
			);
		}

		console.log(
			chalk.cyan(`\nSegment "${segmentId}" requires output from "${depId}":`),
		);

		const outputDir = await search({
			message: `Select ${depId} output`,
			source: (input) => {
				const term = (input ?? "").toLowerCase();
				return choices.filter((c) => c.name.toLowerCase().includes(term));
			},
		});

		selected[depId] = outputDir;
		console.log(chalk.dim(`  → ${outputDir}`));
	}

	return selected;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunInfo {
	runId: string;
	runDir: string;
	identity?: RunIdentity;
	segments: Record<string, { status: string; outputDir?: string }>;
}

async function loadRunStates(
	runsDir: string,
	runDirs: string[],
): Promise<RunInfo[]> {
	const runs: RunInfo[] = [];
	for (const dirName of runDirs) {
		const runDir = join(runsDir, dirName);
		const state = await readRunState(runDir);
		if (state) {
			runs.push({
				runId: dirName,
				runDir,
				identity: state.identity,
				segments: state.segments,
			});
		}
	}
	return runs;
}

function buildChoices(
	runs: RunInfo[],
	depSegmentId: string,
): Array<{ name: string; value: string }> {
	const choices: Array<{ name: string; value: string }> = [];

	for (const run of runs) {
		const seg = run.segments[depSegmentId];
		if (seg?.status === "completed" && seg.outputDir) {
			const dateStr = formatRunDate(run.runId);
			const identityStr = formatIdentity(run.identity);
			choices.push({
				name: `${dateStr}  ${chalk.green("completed")}  ${identityStr}  ${chalk.dim(seg.outputDir)}`,
				value: seg.outputDir,
			});
		}
	}

	return choices;
}

function formatIdentity(identity: RunIdentity | undefined): string {
	if (!identity) return chalk.yellow("identity: unknown");
	const ref = identity.reference ? ` → ${identity.reference}` : "";
	return chalk.cyan(`${identity.input}${ref}`);
}

function formatRunDate(runId: string): string {
	// runId format: YYYYMMDD-HHMMSS
	const match = runId.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
	if (!match) return runId;
	const [, y, mo, d, h, mi, s] = match;
	return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
