/**
 * Self-check loop for agent steps.
 *
 * After an agent generates code, runs static check commands (e.g. `bun run check`)
 * in the generated project directory. If checks fail, spawns a fix agent to repair
 * the issues, then re-checks — up to `maxAttempts` cycles.
 */

import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentQuery } from "../lib/agent.js";
import type { PipelineLogger } from "../lib/logger.js";
import type { LLMProfile, SelfCheckConfig } from "./types.js";

const execAsync = promisify(exec);

const COMMAND_TIMEOUT_MS = 120_000;

interface SelfCheckOpts {
	/** Root workdir (contains project/ subdir) */
	workdir: string;
	/** LLM profile for the fix agent */
	profile: LLMProfile;
	/** Self-check configuration */
	config: SelfCheckConfig;
	/** Logger for status messages */
	logger: PipelineLogger;
}

/** Extract captured output from an exec error. */
function collectErrorOutput(err: unknown): { stdout: string; stderr: string } {
	const e = err as { stdout?: string; stderr?: string; message?: string };
	return {
		stdout: e.stdout ?? "",
		stderr: e.stderr ?? (e.stdout ? "" : (e.message ?? "")),
	};
}

/**
 * Run each command in `commands` sequentially in `cwd`.
 * Returns combined stdout+stderr output and whether all commands passed.
 */
export async function runCheckCommands(
	commands: string[],
	cwd: string,
): Promise<{ ok: boolean; output: string }> {
	const chunks: string[] = [];
	for (const cmd of commands) {
		try {
			const { stdout, stderr } = await execAsync(cmd, {
				cwd,
				timeout: COMMAND_TIMEOUT_MS,
			});
			if (stdout) chunks.push(stdout);
			if (stderr) chunks.push(stderr);
		} catch (err: unknown) {
			const captured = collectErrorOutput(err);
			if (captured.stdout) chunks.push(captured.stdout);
			if (captured.stderr) chunks.push(captured.stderr);
			return { ok: false, output: chunks.join("\n") };
		}
	}
	return { ok: true, output: chunks.join("\n") };
}

/**
 * Run the self-check loop: execute check commands, and if they fail, spawn a
 * fix agent to repair the issues, then re-check — up to `maxAttempts` cycles.
 *
 * @returns `null` if checks pass, or the error output string if all attempts exhausted.
 */
export async function runSelfCheckLoop(
	opts: SelfCheckOpts,
): Promise<string | null> {
	const { workdir, profile, config, logger } = opts;

	const projectDir = await resolveProjectDir(workdir);

	for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
		const result = await runCheckCommands(config.commands, projectDir);
		if (result.ok) return null;

		logger.startStep(
			`self-check fix (attempt ${attempt + 1}/${config.maxAttempts})`,
		);

		const prompt = buildFixPrompt(result.output);
		await agentQuery({
			prompt,
			cwd: projectDir,
			profile,
			stepName: `self-check-fix-${attempt + 1}`,
		});

		logger.completeStep();
	}

	// Final check after all fix attempts
	const finalResult = await runCheckCommands(config.commands, projectDir);
	if (finalResult.ok) return null;
	return finalResult.output;
}

/** Resolve the project directory: prefer `workdir/project`, fall back to workdir. */
async function resolveProjectDir(workdir: string): Promise<string> {
	const candidate = join(workdir, "project");
	try {
		await access(candidate);
		return candidate;
	} catch {
		return workdir;
	}
}

function buildFixPrompt(errorOutput: string): string {
	return `Fix these static check errors in the project. Only modify files you need to fix.

## Errors
${errorOutput}

## Rules
- Fix all errors reported above
- Do not introduce new issues
- Do not delete or rename files unless necessary`;
}
