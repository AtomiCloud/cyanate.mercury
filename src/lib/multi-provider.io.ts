/**
 * Multi-provider IO shell — runs agentQuery in parallel for each provider.
 */

import type { CuiConfig, LLMProfile, StepResult } from "../engine/types.js";
import { agentQuery } from "./agent.js";
import type { PipelineLogger } from "./logger.js";
import { aggregateResults, resolveProviderConfig } from "./multi-provider.js";
import { parseReviewerVerdict } from "./reviewers.js";

export interface MultiProviderQueryOptions {
	providers?: LLMProfile[];
	prompt: string;
	systemPrompt?: string;
	cwd: string;
	stepName: string;
	logger: PipelineLogger;
	maxTurns?: number;
	config: CuiConfig;
	/** Explicit aggregation mode. When omitted, resolved from config.reviewer_matrix[stepName].aggregation */
	aggregation?: "any_reject" | "all_pass";
}

/**
 * Run agentQuery in parallel for each provider, then aggregate results.
 *
 * If providers are not explicitly given, they are resolved from config using
 * resolveProviderConfig (step_matrix → reviewer_matrix → defaults).
 * Aggregation defaults to the reviewer_matrix entry's configured strategy,
 * falling back to "any_reject".
 */
export async function multiProviderQuery(
	opts: MultiProviderQueryOptions,
): Promise<{ results: StepResult[]; aggregated: StepResult }> {
	const { prompt, systemPrompt, cwd, stepName, logger, maxTurns, config } =
		opts;

	// Resolve providers and aggregation from config when not explicitly provided
	const resolved =
		opts.providers !== undefined
			? {
					providers: opts.providers,
					aggregation: opts.aggregation ?? "any_reject",
				}
			: resolveProviderConfig(config, stepName);

	const { providers, aggregation } = resolved;

	const promises = providers.map(async (profile, i) => {
		try {
			const providerName = profile.provider ?? `provider-${i}`;
			logger.startStep(`${stepName}/${providerName}`);
			const output = await agentQuery({
				prompt,
				systemPrompt,
				cwd,
				profile,
				stepName: `${stepName}/${providerName}`,
				logger,
				maxTurns,
				config,
			});
			logger.completeStep();

			const parsed = parseReviewerVerdict(output);
			return {
				status:
					parsed.verdict === "pass" ? ("pass" as const) : ("reject" as const),
				reviews: [
					{
						reviewerId: providerName,
						verdict: parsed.verdict,
						findings: parsed.findings,
						rejectionContext: parsed.rejectionContext,
					},
				],
			};
		} catch (error) {
			logger.failStep(String(error));
			return {
				status: "fail" as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});

	const results = await Promise.all(promises);
	const aggregated = aggregateResults(results, aggregation);

	return { results, aggregated };
}
