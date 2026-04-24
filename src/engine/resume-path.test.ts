import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SegmentRegistry } from "./registry.js";
import {
	looksLikePath,
	parsePath,
	prepareResumeFromPath,
} from "./resume-path.js";
import { createRunState, writePipelineState } from "./state.js";
import type { PhaseDef, SegmentDef } from "./types.js";

const ROOT = "/tmp/mecury-test";
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.map(async (dir) => {
			try {
				await Bun.$`rm -rf ${dir}`.quiet();
			} catch {}
		}),
	);
	tempDirs.length = 0;
});

describe("looksLikePath", () => {
	it("treats bare phase ids as non-paths", () => {
		expect(looksLikePath("harmonize-prepare")).toBe(false);
		expect(looksLikePath("chrome-classify")).toBe(false);
	});

	it("treats values containing a slash as paths", () => {
		expect(looksLikePath("runs/foo/classify")).toBe(true);
		expect(looksLikePath("/abs/path")).toBe(true);
		expect(looksLikePath("./runs/x/y")).toBe(true);
	});
});

describe("parsePath", () => {
	it("parses a segment path", () => {
		const p = parsePath("runs/20260101-000000/classify", ROOT);
		expect(p.sourceRunId).toBe("20260101-000000");
		expect(p.segmentId).toBe("classify");
		expect(p.iterationIndex).toBeUndefined();
		expect(p.iterationPhaseId).toBeUndefined();
		expect(p.sourceRunDir).toBe(`${ROOT}/runs/20260101-000000`);
	});

	it("parses an iteration path", () => {
		const p = parsePath(
			"runs/align-smoke/classify/iteration-3-harmonize-prepare",
			ROOT,
		);
		expect(p.sourceRunId).toBe("align-smoke");
		expect(p.segmentId).toBe("classify");
		expect(p.iterationIndex).toBe(3);
		expect(p.iterationPhaseId).toBe("harmonize-prepare");
	});

	it("handles multi-hyphen phase ids", () => {
		const p = parsePath("runs/r1/classify/iteration-4-harmonize-align", ROOT);
		expect(p.iterationIndex).toBe(4);
		expect(p.iterationPhaseId).toBe("harmonize-align");
	});

	it("accepts absolute paths under rootDir", () => {
		const p = parsePath(`${ROOT}/runs/abc/classify`, ROOT);
		expect(p.sourceRunId).toBe("abc");
	});

	it("rejects paths outside runs/", () => {
		expect(() => parsePath("other/r1/classify", ROOT)).toThrow(
			/must start with "runs\//,
		);
	});

	it("rejects paths outside the workspace root", () => {
		expect(() => parsePath("/etc/passwd", ROOT)).toThrow(/not under/);
	});

	it("rejects over-deep paths", () => {
		expect(() =>
			parsePath("runs/r1/classify/iteration-1-foo/extra", ROOT),
		).toThrow(/expected/);
	});

	it("rejects too-shallow paths (no segment)", () => {
		expect(() => parsePath("runs/r1", ROOT)).toThrow(/expected/);
	});

	it("rejects an iteration dir that doesn't match the pattern", () => {
		expect(() =>
			parsePath("runs/r1/classify/not-an-iteration-dir", ROOT),
		).toThrow(/iteration/);
	});

	it("rejects an iteration dir missing the phase part", () => {
		expect(() => parsePath("runs/r1/classify/iteration-3", ROOT)).toThrow(
			/iteration/,
		);
	});
});

describe("prepareResumeFromPath", () => {
	it("rewrites retained iteration workdirs into the target run on iteration resume", async () => {
		const root = await mkdtemp(join(tmpdir(), "mecury-resume-path-"));
		tempDirs.push(root);

		const runsDir = join(root, "runs");
		const sourceRunId = "20260423-093100";
		const sourceRunDir = join(runsDir, sourceRunId);
		const segmentId = "classify";
		const segDir = join(sourceRunDir, segmentId);
		await mkdir(segDir, { recursive: true });

		const registry = new SegmentRegistry();
		registry.register(
			makeSegment(segmentId, [
				"classify-prepare",
				"chrome-classify",
				"harmonize-prepare",
				"harmonize-align",
			]),
		);

		const runState = createRunState({
			runId: sourceRunId,
			segmentIds: [segmentId],
			identity: { input: "./example/physio", reference: "https://example.com" },
			startSegment: segmentId,
		});
		await writeFile(
			join(sourceRunDir, "run.json"),
			JSON.stringify(runState, null, 2),
		);

		await writePipelineState(segDir, {
			runId: "20260422-105740",
			segmentId,
			status: "failed",
			startedAt: "2026-04-23T00:00:00.000Z",
			currentPhase: "harmonize-align",
			currentIteration: 4,
			iterations: [
				{
					index: 1,
					phaseId: "classify-prepare",
					segmentId,
					status: "passed",
					startedAt: "2026-04-23T00:00:00.000Z",
					finishedAt: "2026-04-23T00:00:01.000Z",
					steps: [],
					workdir: join(
						root,
						"runs/20260422-105740/classify/iteration-1-classify-prepare",
					),
				},
				{
					index: 2,
					phaseId: "chrome-classify",
					segmentId,
					status: "passed",
					startedAt: "2026-04-23T00:00:02.000Z",
					finishedAt: "2026-04-23T00:00:03.000Z",
					steps: [],
					workdir: join(
						root,
						"runs/20260422-105740/classify/iteration-2-chrome-classify",
					),
				},
				{
					index: 3,
					phaseId: "harmonize-prepare",
					segmentId,
					status: "passed",
					startedAt: "2026-04-23T00:00:04.000Z",
					finishedAt: "2026-04-23T00:00:05.000Z",
					steps: [],
					workdir: join(
						root,
						"runs/20260422-105740/classify/iteration-3-harmonize-prepare",
					),
				},
				{
					index: 4,
					phaseId: "harmonize-align",
					segmentId,
					status: "rejected",
					startedAt: "2026-04-23T00:00:06.000Z",
					finishedAt: "2026-04-23T00:00:07.000Z",
					steps: [],
					workdir: join(
						root,
						"runs/20260423-093100/classify/iteration-4-harmonize-align",
					),
				},
			],
		});

		const result = await prepareResumeFromPath({
			rootDir: root,
			fromPath: `runs/${sourceRunId}/${segmentId}/iteration-3-harmonize-prepare`,
			targetRunId: sourceRunId,
			registry,
		});

		expect(result.runId).toBe(sourceRunId);
		expect(result.startSegment).toBe(segmentId);
		expect(result.fromPhase).toBe("harmonize-align");

		const pipelineRaw = await readFile(join(segDir, "pipeline.json"), "utf-8");
		const pipeline = JSON.parse(pipelineRaw) as {
			runId: string;
			iterations: Array<{ index: number; phaseId: string; workdir: string }>;
		};

		expect(pipeline.runId).toBe(sourceRunId);
		expect(pipeline.iterations.map((i) => i.index)).toEqual([1, 2, 3]);
		expect(pipeline.iterations.map((i) => i.workdir)).toEqual([
			join(segDir, "iteration-1-classify-prepare"),
			join(segDir, "iteration-2-chrome-classify"),
			join(segDir, "iteration-3-harmonize-prepare"),
		]);
	});
});

function makeSegment(segmentId: string, phases: string[]): SegmentDef {
	return {
		id: segmentId,
		name: segmentId,
		description: "test",
		depends: [],
		phases: phases.map(
			(id): PhaseDef => ({
				id,
				name: id,
				description: id,
				maxRetries: 0,
				steps: [],
			}),
		),
		mergeInputs: async () => {},
		extractOutput: async () => {},
	};
}
