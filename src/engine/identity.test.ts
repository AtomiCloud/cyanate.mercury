import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeIdentityDivergence, resolveIdentity } from "./identity.js";
import type { CuiConfig, RunIdentity, RunState } from "./types.js";

function makeConfig(input: string, reference?: string): CuiConfig {
	return {
		input,
		reference,
		defaults: {
			provider: "anthropic",
			model: "claude-opus-4-6",
			maxTurns: 80,
			env: {},
		},
		profiles: {},
		heartbeat: { timeout: 900_000, interval: 30_000 },
		logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
	};
}

async function writeRun(
	runsRoot: string,
	runId: string,
	identity: RunIdentity | undefined,
	segmentId: string,
): Promise<string> {
	const runDir = join(runsRoot, runId);
	const segDir = join(runDir, segmentId);
	await mkdir(segDir, { recursive: true });
	const state: RunState = {
		runId,
		status: "completed",
		startedAt: "2026-04-14T10:00:00Z",
		finishedAt: "2026-04-14T10:30:00Z",
		identity,
		segments: {
			[segmentId]: { status: "completed", outputDir: segDir },
		},
	};
	await writeFile(join(runDir, "run.json"), JSON.stringify(state, null, 2));
	return segDir;
}

describe("resolveIdentity", () => {
	let root: string;
	let warnings: string[];
	const captureWarn = (msg: string) => {
		warnings.push(msg);
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "identity-test-"));
		warnings = [];
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("no deps → returns config identity", async () => {
		const config = makeConfig("example/royal", "https://a.com");
		const got = await resolveIdentity({ config });
		expect(got).toEqual({ input: "example/royal", reference: "https://a.com" });
	});

	it("one dep with identity → returns that identity", async () => {
		const segDir = await writeRun(
			root,
			"20260414-100000",
			{ input: "example/royal", reference: "https://a.com" },
			"prepare",
		);
		const config = makeConfig("example/physio", "https://b.com");
		const got = await resolveIdentity({
			config,
			depOverrides: { prepare: segDir },
			onWarn: captureWarn,
		});
		expect(got).toEqual({ input: "example/royal", reference: "https://a.com" });
		expect(warnings).toHaveLength(0);
	});

	it("two consistent deps → returns shared identity", async () => {
		const prep = await writeRun(
			root,
			"20260414-100000",
			{ input: "example/royal", reference: "https://a.com" },
			"prepare",
		);
		const anly = await writeRun(
			root,
			"20260414-100000",
			{ input: "example/royal", reference: "https://a.com" },
			"analyze",
		);
		const config = makeConfig("example/physio", "https://b.com");
		const got = await resolveIdentity({
			config,
			depOverrides: { prepare: prep, analyze: anly },
		});
		expect(got).toEqual({ input: "example/royal", reference: "https://a.com" });
	});

	it("two conflicting deps on input → throws field-specific error", async () => {
		const prep = await writeRun(
			root,
			"20260414-100000",
			{ input: "example/royal", reference: "https://a.com" },
			"prepare",
		);
		const anly = await writeRun(
			root,
			"20260414-110000",
			{ input: "example/physio", reference: "https://a.com" },
			"analyze",
		);
		const config = makeConfig("example/royal", "https://a.com");

		await expect(
			resolveIdentity({
				config,
				depOverrides: { prepare: prep, analyze: anly },
			}),
		).rejects.toThrow(/disagree on input/);

		try {
			await resolveIdentity({
				config,
				depOverrides: { prepare: prep, analyze: anly },
			});
		} catch (err) {
			const msg = String(err);
			expect(msg).toContain("20260414-100000");
			expect(msg).toContain("20260414-110000");
			expect(msg).toContain("example/royal");
			expect(msg).toContain("example/physio");
			expect(msg).toContain("scraper input");
		}
	});

	it("two conflicting deps on reference → throws field-specific error", async () => {
		const anly = await writeRun(
			root,
			"20260414-100000",
			{ input: "example/royal", reference: "https://a.com" },
			"analyze",
		);
		const wire = await writeRun(
			root,
			"20260414-110000",
			{ input: "example/royal", reference: "https://b.com" },
			"wireframe",
		);
		const config = makeConfig("example/royal", "https://a.com");

		await expect(
			resolveIdentity({
				config,
				depOverrides: { analyze: anly, wireframe: wire },
			}),
		).rejects.toThrow(/disagree on reference/);
	});

	it("deps contribute different fields with no overlap → merge per field", async () => {
		// analyze sets reference but not input (reference-only legacy shape simulation);
		// wireframe sets input but not reference.
		const anly = await writeRun(
			root,
			"20260414-100000",
			{ input: "example/royal", reference: "https://new-ref.com" },
			"analyze",
		);
		const wire = await writeRun(
			root,
			"20260414-110000",
			{ input: "example/royal", reference: undefined },
			"wireframe",
		);
		const config = makeConfig("example/royal", "https://old.com");
		const got = await resolveIdentity({
			config,
			depOverrides: { analyze: anly, wireframe: wire },
		});
		// reference comes from analyze (only non-empty value);
		// input agrees across both deps.
		expect(got).toEqual({
			input: "example/royal",
			reference: "https://new-ref.com",
		});
	});

	it("legacy dep (no identity in run.json) → falls back to config with warning", async () => {
		const segDir = await writeRun(
			root,
			"20260414-100000",
			undefined,
			"prepare",
		);
		const config = makeConfig("example/royal", "https://a.com");
		const got = await resolveIdentity({
			config,
			depOverrides: { prepare: segDir },
			onWarn: captureWarn,
		});
		expect(got).toEqual({ input: "example/royal", reference: "https://a.com" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/legacy run/);
	});

	it("missing run.json → falls back with warning", async () => {
		const nowhere = join(root, "nonexistent", "prepare");
		const config = makeConfig("example/royal");
		const got = await resolveIdentity({
			config,
			depOverrides: { prepare: nowhere },
			onWarn: captureWarn,
		});
		expect(got).toEqual({ input: "example/royal", reference: undefined });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/no run.json/);
	});
});

describe("describeIdentityDivergence", () => {
	it("matching identities → null", () => {
		const got = describeIdentityDivergence(
			{ input: "a", reference: "r" },
			{ input: "a", reference: "r" },
		);
		expect(got).toBeNull();
	});

	it("diverging input → non-null message naming both", () => {
		const got = describeIdentityDivergence(
			{ input: "example/royal", reference: "https://a.com" },
			{ input: "example/physio", reference: "https://b.com" },
		);
		expect(got).not.toBeNull();
		expect(got).toContain("example/royal");
		expect(got).toContain("example/physio");
	});
});
