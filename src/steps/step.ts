/**
 * Step builder helpers.
 *
 * These helpers make it easy to define steps for segments
 * using the engine's StepDef interface.
 */

import type {
	StepContext,
	StepDef,
	StepFn,
	StepResult,
} from "../engine/types.js";
import { agentQuery } from "../lib/agent.js";
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
}): StepDef {
	const run: StepFn = async (ctx) => {
		const start = Date.now();
		const prompt = await opts.buildPrompt(ctx);

		const output = await agentQuery({
			prompt,
			systemPrompt: opts.systemPrompt,
			cwd: ctx.workdir,
			profile: ctx.profile,
			stepName: `${ctx.segmentId}/${ctx.phaseId}/${ctx.stepId}`,
			logger: ctx.logger,
			maxTurns: ctx.profile.maxTurns,
			config: ctx.config,
		});

		if (opts.validate) {
			const result = await opts.validate(ctx, output);
			result.duration = Date.now() - start;
			return result;
		}

		return { status: "pass", duration: Date.now() - start };
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
		const prompt = await opts.buildPrompt(ctx);

		const output = await agentQuery({
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
			? opts.parseVerdict(output)
			: defaultParseVerdict(opts.id, output);

		result.duration = Date.now() - start;
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
