import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineLogger } from "../lib/logger.js";
import { runCheckCommands, runSelfCheckLoop } from "./self-check.js";

function noopLogger(): PipelineLogger {
	return {
		startStep() {},
		updateTurn() {},
		completeStep() {},
		failStep() {},
		skipStep() {},
		startSegment() {},
		finishSegment() {
			return {
				steps: 0,
				turns: 0,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
				duration: 0,
			};
		},
		flush() {},
		destroy() {},
	};
}

describe("self-check", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "self-check-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// runCheckCommands
	// -----------------------------------------------------------------------

	describe("runCheckCommands", () => {
		it("all pass — returns ok: true", async () => {
			const result = await runCheckCommands(["echo ok"], dir);
			expect(result.ok).toBe(true);
			expect(result.output).toContain("ok");
		});

		it("command fails — returns ok: false", async () => {
			await writeFile(
				join(dir, "fail.sh"),
				"#!/bin/bash\necho 'error: something broke' >&2\nexit 1\n",
				{ mode: 0o755 },
			);
			const result = await runCheckCommands(
				[`bash ${join(dir, "fail.sh")}`],
				dir,
			);
			expect(result.ok).toBe(false);
			expect(result.output).toContain("something broke");
		});

		it("collects both stdout and stderr", async () => {
			await writeFile(
				join(dir, "both.sh"),
				'#!/bin/bash\necho "stdout-line"\necho "stderr-line" >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			const result = await runCheckCommands(
				[`bash ${join(dir, "both.sh")}`],
				dir,
			);
			expect(result.ok).toBe(false);
			expect(result.output).toContain("stdout-line");
			expect(result.output).toContain("stderr-line");
		});

		it("multiple commands — all pass", async () => {
			const result = await runCheckCommands(["echo first", "echo second"], dir);
			expect(result.ok).toBe(true);
			expect(result.output).toContain("first");
			expect(result.output).toContain("second");
		});

		it("multiple commands — second fails, stops early", async () => {
			const result = await runCheckCommands(
				["echo first", "exit 1", "echo third"],
				dir,
			);
			expect(result.ok).toBe(false);
			expect(result.output).toContain("first");
			// third command should not have run
			expect(result.output).not.toContain("third");
		});
	});

	// -----------------------------------------------------------------------
	// runSelfCheckLoop
	// -----------------------------------------------------------------------

	describe("runSelfCheckLoop", () => {
		it("passes on first try — returns null without fix agent", async () => {
			const result = await runSelfCheckLoop({
				workdir: dir,
				profile: { provider: "test", model: "test-model" },
				config: { commands: ["echo ok"], maxAttempts: 2 },
				logger: noopLogger(),
			});
			expect(result).toBeNull();
		});

		it("handles missing project dir — falls back to workdir", async () => {
			// dir has no project/ subdir, so the loop should run commands in dir itself
			const result = await runSelfCheckLoop({
				workdir: dir,
				profile: { provider: "test", model: "test-model" },
				config: { commands: ["echo ok"], maxAttempts: 1 },
				logger: noopLogger(),
			});
			expect(result).toBeNull();
		});

		it("uses project/ subdir when it exists", async () => {
			const projectDir = join(dir, "project");
			await mkdir(projectDir);
			// Create a marker file in the project dir
			await writeFile(join(projectDir, "marker.txt"), "found");

			const result = await runSelfCheckLoop({
				workdir: dir,
				profile: { provider: "test", model: "test-model" },
				config: { commands: ["cat marker.txt"], maxAttempts: 1 },
				logger: noopLogger(),
			});
			expect(result).toBeNull();
		});
	});
});
