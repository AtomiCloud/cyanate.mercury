import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DomainDescriptor,
	type GenerateAgentRole,
	type GenerateRunAgentFn,
	generateDomainOps,
	generateDomainOpsBatch,
} from "./domain-ops-generator.js";

interface SampleRenameOp {
	kind: "flat";
	from: string;
	to: string;
	reason: string;
}

const sampleDomain: DomainDescriptor = {
	name: "rename",
	opSchema:
		'{"kind":"flat","from":"<candidate>","to":"<canonical>","reason":"<short>"}',
};

const passVerdict = JSON.stringify({ verdict: "pass", findings: [] });

function testWorkdir(name: string): string {
	return join(tmpdir(), `mecury-domain-ops-${process.pid}-${name}`);
}

type ScriptByRole = Partial<Record<GenerateAgentRole, string[]>>;

function runAgentScript(script: ScriptByRole): {
	runAgent: GenerateRunAgentFn;
	calls: Array<{ role: GenerateAgentRole; attempt: number }>;
} {
	const calls: Array<{ role: GenerateAgentRole; attempt: number }> = [];
	const queues: ScriptByRole = {
		generate: [...(script.generate ?? [])],
		"review-a": [...(script["review-a"] ?? [])],
		"review-b": [...(script["review-b"] ?? [])],
	};
	const runAgent: GenerateRunAgentFn = async (args) => {
		calls.push({ role: args.role, attempt: args.attempt });
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

describe("generateDomainOps", () => {
	it("produces ops when generator + both reviewers pass", async () => {
		const opsDoc = {
			ops: [{ kind: "flat", from: "a", to: "b", reason: "canonical" }],
		};
		const { runAgent } = runAgentScript({
			generate: [JSON.stringify(opsDoc)],
			"review-a": [passVerdict],
			"review-b": [passVerdict],
		});

		const result = await generateDomainOps<SampleRenameOp>({
			intent: "Rename a to b.",
			domain: sampleDomain,
			runAgent,
			workdir: testWorkdir("happy"),
		});

		expect(result.ops).toEqual(opsDoc.ops as SampleRenameOp[]);
		expect(result.totals.turns).toBe(3);
	});

	it("retries when generator response is unparseable", async () => {
		const opsDoc = {
			ops: [{ kind: "flat", from: "a", to: "b", reason: "canonical" }],
		};
		const { runAgent } = runAgentScript({
			generate: ["garbage", JSON.stringify(opsDoc)],
			"review-a": [passVerdict],
			"review-b": [passVerdict],
		});

		const result = await generateDomainOps<SampleRenameOp>({
			intent: "Rename a to b.",
			domain: sampleDomain,
			runAgent,
			workdir: testWorkdir("unparseable"),
		});

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]?.parseError).toContain("not a JSON object");
	});

	it("retries on reviewer A rejection", async () => {
		const opsDoc = {
			ops: [{ kind: "flat", from: "a", to: "b", reason: "canonical" }],
		};
		const { runAgent } = runAgentScript({
			generate: [JSON.stringify(opsDoc), JSON.stringify(opsDoc)],
			"review-a": [
				JSON.stringify({
					verdict: "reject",
					findings: [{ path: "ops[0]", issue: "nope" }],
				}),
				passVerdict,
			],
			"review-b": [passVerdict, passVerdict],
		});

		const result = await generateDomainOps<SampleRenameOp>({
			intent: "Rename a to b.",
			domain: sampleDomain,
			runAgent,
			workdir: testWorkdir("reject-a"),
		});

		expect(result.attempts).toHaveLength(2);
	});

	it("treats disagreement as reject", async () => {
		const opsDoc = {
			ops: [{ kind: "flat", from: "a", to: "b", reason: "canonical" }],
		};
		const { runAgent } = runAgentScript({
			generate: [JSON.stringify(opsDoc), JSON.stringify(opsDoc)],
			"review-a": [passVerdict, passVerdict],
			"review-b": [
				JSON.stringify({
					verdict: "reject",
					findings: [{ path: "", issue: "weaker reviewer disagrees" }],
				}),
				passVerdict,
			],
		});

		const result = await generateDomainOps<SampleRenameOp>({
			intent: "Rename a to b.",
			domain: sampleDomain,
			runAgent,
			workdir: testWorkdir("disagreement"),
		});

		expect(result.attempts).toHaveLength(2);
	});

	it("throws after budget exhausted", async () => {
		const opsDoc = {
			ops: [{ kind: "flat", from: "a", to: "b", reason: "canonical" }],
		};
		const { runAgent } = runAgentScript({
			generate: [JSON.stringify(opsDoc), JSON.stringify(opsDoc)],
			"review-a": [
				JSON.stringify({ verdict: "reject", findings: [] }),
				JSON.stringify({ verdict: "reject", findings: [] }),
			],
			"review-b": [passVerdict, passVerdict],
		});

		await expect(
			generateDomainOps<SampleRenameOp>({
				intent: "Rename a to b.",
				domain: sampleDomain,
				runAgent,
				workdir: testWorkdir("exhausted"),
				budget: 2,
			}),
		).rejects.toThrow("exhausted 2 attempts");
	});
});

describe("generateDomainOpsBatch", () => {
	it("materializes intents concurrently and returns ops in intent order", async () => {
		let active = 0;
		let peak = 0;
		const runAgent: GenerateRunAgentFn = async (args) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => {
				setTimeout(resolve, args.prompt.includes("first") ? 1 : 5);
			});
			active--;
			if (args.role === "generate") {
				const isFirst = args.prompt.includes("first");
				return {
					output: JSON.stringify({
						ops: [
							{
								kind: "flat",
								from: isFirst ? "a" : "c",
								to: isFirst ? "b" : "d",
								reason: isFirst ? "first" : "second",
							},
						],
					}),
					turns: 1,
					inputTokens: 10,
					outputTokens: 5,
					cost: 0.01,
				};
			}
			return {
				output: passVerdict,
				turns: 1,
				inputTokens: 10,
				outputTokens: 5,
				cost: 0.01,
			};
		};

		const result = await generateDomainOpsBatch<string, SampleRenameOp>({
			intents: ["first", "second"],
			intentToText: (intent) => intent,
			domain: sampleDomain,
			runAgent,
			workdir: testWorkdir("batch-order"),
			concurrency: 2,
		});

		expect(result.ops.map((op) => op.reason)).toEqual(["first", "second"]);
		// Both intents in flight = concurrency 2. Inside each, reviewers A+B run in
		// parallel, so peak agent-call concurrency can exceed the batch semaphore's
		// limit. 2 means intents truly overlapped rather than serialized.
		expect(peak).toBeGreaterThanOrEqual(2);
	});

	it("throws when concurrency is invalid", async () => {
		await expect(
			generateDomainOpsBatch({
				intents: ["x"],
				intentToText: (intent) => intent,
				domain: sampleDomain,
				runAgent: async () => ({
					output: "",
					turns: 0,
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
				}),
				workdir: testWorkdir("bad-concurrency"),
				concurrency: 0,
			}),
		).rejects.toThrow("concurrency must be a positive integer");
	});
});
