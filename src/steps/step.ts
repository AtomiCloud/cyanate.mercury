/**
 * Step builder helpers.
 *
 * These helpers make it easy to define steps for segments
 * using the engine's StepDef interface.
 */

import { runSelfCheckLoop } from "../engine/self-check.js";
import type {
	SelfCheckConfig,
	StepContext,
	StepDef,
	StepFn,
	StepResult,
} from "../engine/types.js";
import { agentQueryWithMetrics } from "../lib/agent.js";
import { parseReviewerVerdict } from "../lib/reviewers.js";

/**
 * Create an agent step — runs a Claude SDK agent with the given prompt.
 */
export function agentStep(opts: {
	id: string;
	name: string;
	description: string;
	systemPrompt?: string;
	buildPrompt: (ctx: StepContext) => string | Promise<string>;
	/** Validate output after agent completes (return reviews/errors) */
	validate?: (ctx: StepContext, output: string) => Promise<StepResult>;
	profileKey?: string;
	/** Run static checks after agent + validate, auto-fix on failure. */
	selfCheck?: SelfCheckConfig;
}): StepDef {
	const run: StepFn = async (ctx) => {
		const start = Date.now();
		let prompt = await opts.buildPrompt(ctx);

		if (ctx.rejectionContext) {
			prompt += `\n\n---\nPREVIOUS ATTEMPT REJECTED. Fix these issues:\n${ctx.rejectionContext}`;
		}

		const agentResult = await agentQueryWithMetrics({
			prompt,
			systemPrompt: opts.systemPrompt,
			cwd: ctx.workdir,
			profile: ctx.profile,
			stepName: `${ctx.segmentId}/${ctx.phaseId}/${ctx.stepId}`,
			logger: ctx.logger,
			maxTurns: ctx.profile.maxTurns,
			config: ctx.config,
		});

		const metrics = {
			turns: agentResult.turns,
			inputTokens: agentResult.inputTokens,
			outputTokens: agentResult.outputTokens,
			cost: agentResult.cost,
		};

		if (opts.validate) {
			const result = await opts.validate(ctx, agentResult.output);
			if (result.status !== "pass") {
				result.duration = Date.now() - start;
				Object.assign(result, metrics);
				return result;
			}
		}

		if (opts.selfCheck) {
			const errors = await runSelfCheckLoop({
				workdir: ctx.workdir,
				profile: ctx.profile,
				config: opts.selfCheck,
				logger: ctx.logger,
			});
			if (errors) {
				return {
					status: "reject",
					duration: Date.now() - start,
					...metrics,
					reviews: [
						{
							reviewerId: `${opts.id}-self-check`,
							verdict: "reject",
							findings: errors,
							rejectionContext: `Self-check failed:\n${errors}`,
						},
					],
				};
			}
		}

		return { status: "pass", duration: Date.now() - start, ...metrics };
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "agent",
		profileKey: opts.profileKey,
		run,
	};
}

/**
 * Create a programmatic step — runs a TypeScript function.
 */
export function programmaticStep(opts: {
	id: string;
	name: string;
	description: string;
	run: StepFn;
}): StepDef {
	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "programmatic",
		run: opts.run,
	};
}

/**
 * Create an agent-typed step with custom run logic.
 *
 * Use for fan-out steps that call agentQuery internally but need
 * the engine to classify them as non-deterministic for retry eligibility.
 */
export function agentFanOutStep(opts: {
	id: string;
	name: string;
	description: string;
	profileKey?: string;
	run: StepFn;
}): StepDef {
	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "agent",
		profileKey: opts.profileKey,
		run: opts.run,
	};
}

/**
 * Create a reviewer step — runs an AI judge that returns pass/reject.
 */
export function reviewerStep(opts: {
	id: string;
	name: string;
	description: string;
	systemPrompt?: string;
	buildPrompt: (ctx: StepContext) => string | Promise<string>;
	/** Parse agent output into a verdict */
	parseVerdict?: (output: string) => StepResult;
	profileKey?: string;
}): StepDef {
	const run: StepFn = async (ctx) => {
		const start = Date.now();
		let prompt = await opts.buildPrompt(ctx);

		if (ctx.rejectionContext) {
			prompt += `\n\n---\nPREVIOUS ATTEMPT REJECTED — context from prior iteration:\n${ctx.rejectionContext}`;
		}

		const agentResult = await agentQueryWithMetrics({
			prompt,
			systemPrompt: opts.systemPrompt,
			cwd: ctx.workdir,
			profile: ctx.profile,
			stepName: `${ctx.segmentId}/${ctx.phaseId}/${ctx.stepId}`,
			logger: ctx.logger,
			maxTurns: ctx.profile.maxTurns,
			config: ctx.config,
		});

		const result = opts.parseVerdict
			? opts.parseVerdict(agentResult.output)
			: defaultParseVerdict(opts.id, agentResult.output);

		result.duration = Date.now() - start;
		result.turns = agentResult.turns;
		result.inputTokens = agentResult.inputTokens;
		result.outputTokens = agentResult.outputTokens;
		result.cost = agentResult.cost;
		return result;
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "reviewer",
		profileKey: opts.profileKey,
		run,
	};
}

/**
 * Default verdict parser — delegates to shared parseReviewerVerdict.
 */
function defaultParseVerdict(reviewerId: string, output: string): StepResult {
	const parsed = parseReviewerVerdict(output);
	return {
		status: parsed.verdict === "pass" ? "pass" : "reject",
		reviews: [
			{
				reviewerId,
				verdict: parsed.verdict,
				findings: parsed.findings,
				rejectionContext: parsed.rejectionContext,
			},
		],
	};
}
