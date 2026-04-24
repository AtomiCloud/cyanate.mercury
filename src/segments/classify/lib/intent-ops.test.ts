import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyOps,
	type CompileAgentRole,
	type CompileRunAgentFn,
	checkProvenance,
	compileIntentToOps,
	diffToPlan,
	enumerateLeafPaths,
	type ProjectorOutput,
	parseProjectorOutput,
	parseReviewerVerdict,
} from "./intent-ops.js";

const roleListIntent =
	"Convert the scalar role list at requiredInputs into named empty object entries.";

const roleListInput = { requiredInputs: ["primary", "secondary"] };
const roleListOutput = { requiredInputs: { primary: {}, secondary: {} } };
const roleListProjection: ProjectorOutput = {
	output: roleListOutput,
	provenance: {
		"requiredInputs.primary": {
			from: "intent",
			phrase: "empty object entries",
		},
		"requiredInputs.secondary": {
			from: "intent",
			phrase: "empty object entries",
		},
	},
};

const passVerdict = JSON.stringify({ verdict: "pass", findings: [] });

function testWorkdir(name: string): string {
	return join(tmpdir(), `mecury-intent-ops-${process.pid}-${name}`);
}

type ScriptByRole = Partial<Record<CompileAgentRole, string[]>>;

interface ScriptedCall {
	role: CompileAgentRole;
	attempt: number;
	prompt: string;
	workdir: string;
}

function runAgentScript(script: ScriptByRole): {
	runAgent: CompileRunAgentFn;
	calls: ScriptedCall[];
} {
	const calls: ScriptedCall[] = [];
	const queues: ScriptByRole = {
		project: [...(script.project ?? [])],
		"review-a": [...(script["review-a"] ?? [])],
		"review-b": [...(script["review-b"] ?? [])],
	};
	const runAgent: CompileRunAgentFn = async (args) => {
		calls.push({
			role: args.role,
			attempt: args.attempt,
			prompt: args.prompt,
			workdir: args.workdir,
		});
		const output = queues[args.role]?.shift();
		if (output === undefined) {
			throw new Error(`missing scripted response for ${args.role}`);
		}
		return {
			output,
			turns: 1,
			inputTokens: 10,
			outputTokens: 5,
			cost: 0.01,
		};
	};
	return { runAgent, calls };
}

describe("enumerateLeafPaths", () => {
	it("enumerates every scalar, empty object, and empty array path", () => {
		const paths = enumerateLeafPaths({
			a: 1,
			b: { c: "x" },
			d: [10, 20],
			e: {},
			f: [],
		}).sort();

		expect(paths).toEqual(["a", "b.c", "d[0]", "d[1]", "e", "f"]);
	});

	it("treats empty arrays and empty objects as leaves with their own path", () => {
		expect(enumerateLeafPaths({})).toEqual([""]);
		expect(enumerateLeafPaths([])).toEqual([""]);
		expect(enumerateLeafPaths(42)).toEqual([""]);
	});
});

describe("checkProvenance", () => {
	it("passes when every leaf is justified by input and intent", () => {
		const errors = checkProvenance(
			roleListInput,
			roleListIntent,
			roleListProjection,
		);
		expect(errors).toEqual([]);
	});

	it("rejects when input-cited path is missing", () => {
		const errors = checkProvenance(roleListInput, roleListIntent, {
			output: { requiredInputs: { primary: {} } },
			provenance: {
				"requiredInputs.primary": {
					from: "input",
					path: "requiredInputs[9]",
				},
			},
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]?.issue).toContain("not present in input");
	});

	it("rejects when input-cited value does not equal output value", () => {
		const errors = checkProvenance(roleListInput, roleListIntent, {
			output: { label: "elsewhere" },
			provenance: {
				label: { from: "input", path: "requiredInputs[0]" },
			},
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]?.issue).toContain("!=");
	});

	it("rejects when intent phrase is not a substring", () => {
		const errors = checkProvenance({}, "Normalize things.", {
			output: { note: "made up phrase" },
			provenance: { note: { from: "intent", phrase: "NOT THERE" } },
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]?.issue).toContain("not a substring");
	});

	it("rejects output leaves with no provenance entry", () => {
		const errors = checkProvenance({}, "x", {
			output: { a: 1, b: 2 },
			provenance: { a: { from: "derived", reason: "constant" } },
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]?.path).toBe("b");
	});

	it("rejects provenance entries that do not map to any output leaf", () => {
		const errors = checkProvenance({}, "x", {
			output: { a: 1 },
			provenance: {
				a: { from: "derived", reason: "constant" },
				phantom: { from: "derived", reason: "nothing here" },
			},
		});
		expect(errors.some((e) => e.path === "phantom")).toBe(true);
	});
});

describe("diff + applyOps round-trip", () => {
	it("computes forward and backward patches that round-trip through the library", () => {
		const plan = diffToPlan(roleListInput, roleListOutput, roleListIntent);
		expect(applyOps(roleListInput, plan, "forward")).toEqual(roleListOutput);
		expect(applyOps(roleListOutput, plan, "backward")).toEqual(roleListInput);
	});

	it("returns empty patches when input equals output", () => {
		const plan = diffToPlan({ a: 1 }, { a: 1 }, "noop");
		expect(plan.forward).toEqual([]);
		expect(plan.backward).toEqual([]);
	});

	it("handles nested restructuring", () => {
		const before = { items: [{ id: 1 }, { id: 2 }], obsolete: true };
		const after = {
			items: [
				{ id: 1, name: "a" },
				{ id: 2, name: "b" },
			],
		};
		const plan = diffToPlan(before, after, "add names; drop obsolete");
		expect(applyOps(before, plan, "forward")).toEqual(after);
		expect(applyOps(after, plan, "backward")).toEqual(before);
	});
});

describe("parseReviewerVerdict", () => {
	it("parses pass with empty findings", () => {
		expect(parseReviewerVerdict(passVerdict).verdict).toBe("pass");
	});

	it("parses reject with findings", () => {
		const v = parseReviewerVerdict(
			JSON.stringify({
				verdict: "reject",
				findings: [{ path: "a.b", issue: "unjustified" }],
			}),
		);
		expect(v.verdict).toBe("reject");
		expect(v.findings).toEqual([{ path: "a.b", issue: "unjustified" }]);
	});

	it("treats unrecognized JSON as reject", () => {
		const v = parseReviewerVerdict(JSON.stringify({ something: true }));
		expect(v.verdict).toBe("reject");
	});

	it("treats non-JSON as reject", () => {
		expect(parseReviewerVerdict("nothing parseable").verdict).toBe("reject");
	});
});

describe("parseProjectorOutput", () => {
	it("extracts output and provenance from a clean JSON response", () => {
		const parsed = parseProjectorOutput(JSON.stringify(roleListProjection));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value.output).toEqual(roleListOutput);
	});

	it("rejects responses missing provenance", () => {
		const parsed = parseProjectorOutput(JSON.stringify({ output: {} }));
		expect(parsed.ok).toBe(false);
	});

	it("rejects responses missing output", () => {
		const parsed = parseProjectorOutput(JSON.stringify({ provenance: {} }));
		expect(parsed.ok).toBe(false);
	});
});

describe("compileIntentToOps closed loop", () => {
	it("compiles a plan when projector, provenance, and both reviewers pass", async () => {
		const { runAgent, calls } = runAgentScript({
			project: [JSON.stringify(roleListProjection)],
			"review-a": [passVerdict],
			"review-b": [passVerdict],
		});

		const result = await compileIntentToOps({
			input: roleListInput,
			intent: roleListIntent,
			runAgent,
			workdir: testWorkdir("closed-loop"),
		});

		expect(result.output).toEqual(roleListOutput);
		expect(applyOps(roleListInput, result.plan, "forward")).toEqual(
			roleListOutput,
		);
		expect(applyOps(roleListOutput, result.plan, "backward")).toEqual(
			roleListInput,
		);
		expect(result.totals.turns).toBe(3);
		expect(calls.map((c) => c.role)).toEqual([
			"project",
			"review-a",
			"review-b",
		]);
	});

	it("retries the projector when provenance check fails", async () => {
		const badProjection: ProjectorOutput = {
			output: { requiredInputs: { primary: {} } },
			provenance: {
				"requiredInputs.primary": {
					from: "input",
					path: "doesnt.exist",
				},
			},
		};
		const goodProjection: ProjectorOutput = {
			output: { requiredInputs: { primary: {} } },
			provenance: {
				"requiredInputs.primary": {
					from: "intent",
					phrase: "empty object entries",
				},
			},
		};
		const { runAgent, calls } = runAgentScript({
			project: [JSON.stringify(badProjection), JSON.stringify(goodProjection)],
			"review-a": [passVerdict],
			"review-b": [passVerdict],
		});

		const result = await compileIntentToOps({
			input: roleListInput,
			intent: roleListIntent,
			runAgent,
			workdir: testWorkdir("provenance-retry"),
		});

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]?.provenanceErrors?.length).toBeGreaterThan(0);
		expect(result.attempts[1]?.reviewers?.a.verdict.verdict).toBe("pass");
		expect(calls.map((c) => `${c.role}:${c.attempt}`)).toEqual([
			"project:0",
			"project:1",
			"review-a:1",
			"review-b:1",
		]);
		expect(calls[1]?.prompt).toContain("Previous attempt failed");
	});

	it("retries when reviewer A rejects", async () => {
		const { runAgent, calls } = runAgentScript({
			project: [
				JSON.stringify(roleListProjection),
				JSON.stringify(roleListProjection),
			],
			"review-a": [
				JSON.stringify({
					verdict: "reject",
					findings: [
						{ path: "requiredInputs.secondary", issue: "unjustified" },
					],
				}),
				passVerdict,
			],
			"review-b": [passVerdict, passVerdict],
		});

		const result = await compileIntentToOps({
			input: roleListInput,
			intent: roleListIntent,
			runAgent,
			workdir: testWorkdir("review-a-reject"),
		});

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]?.reviewers?.a.verdict.verdict).toBe("reject");
		expect(calls.map((c) => `${c.role}:${c.attempt}`)).toEqual([
			"project:0",
			"review-a:0",
			"review-b:0",
			"project:1",
			"review-a:1",
			"review-b:1",
		]);
	});

	it("retries when reviewer B rejects even if A passes", async () => {
		const { runAgent } = runAgentScript({
			project: [
				JSON.stringify(roleListProjection),
				JSON.stringify(roleListProjection),
			],
			"review-a": [passVerdict, passVerdict],
			"review-b": [
				JSON.stringify({
					verdict: "reject",
					findings: [{ path: "", issue: "noisy" }],
				}),
				passVerdict,
			],
		});

		const result = await compileIntentToOps({
			input: roleListInput,
			intent: roleListIntent,
			runAgent,
			workdir: testWorkdir("review-b-reject"),
		});

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]?.reviewers?.b.verdict.verdict).toBe("reject");
	});

	it("treats reviewer disagreement as reject", async () => {
		const { runAgent } = runAgentScript({
			project: [
				JSON.stringify(roleListProjection),
				JSON.stringify(roleListProjection),
			],
			"review-a": [passVerdict, passVerdict],
			"review-b": [
				JSON.stringify({
					verdict: "reject",
					findings: [{ path: "", issue: "weaker reviewer disagrees" }],
				}),
				passVerdict,
			],
		});

		const result = await compileIntentToOps({
			input: roleListInput,
			intent: roleListIntent,
			runAgent,
			workdir: testWorkdir("disagreement"),
		});

		expect(result.attempts).toHaveLength(2);
	});

	it("throws after exhausting the budget", async () => {
		const { runAgent } = runAgentScript({
			project: [
				JSON.stringify(roleListProjection),
				JSON.stringify(roleListProjection),
			],
			"review-a": [
				JSON.stringify({ verdict: "reject", findings: [] }),
				JSON.stringify({ verdict: "reject", findings: [] }),
			],
			"review-b": [passVerdict, passVerdict],
		});

		await expect(
			compileIntentToOps({
				input: roleListInput,
				intent: roleListIntent,
				runAgent,
				workdir: testWorkdir("budget-exhausted"),
				budget: 2,
			}),
		).rejects.toThrow("exhausted 2 attempts");
	});

	it("retries when projector response is unparseable", async () => {
		const { runAgent } = runAgentScript({
			project: ["not json at all", JSON.stringify(roleListProjection)],
			"review-a": [passVerdict],
			"review-b": [passVerdict],
		});

		const result = await compileIntentToOps({
			input: roleListInput,
			intent: roleListIntent,
			runAgent,
			workdir: testWorkdir("unparseable-projector"),
		});

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]?.error).toContain("not a JSON object");
	});
});
