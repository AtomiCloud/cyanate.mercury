/**
 * LLM profile resolution with cascading fallback.
 *
 * Resolution order: segment.phase.step → segment.phase → segment → defaults
 */

import type { CuiConfig, LLMProfile } from "./types.js";

/**
 * Resolve the effective LLM profile for a given step.
 *
 * Cascades through increasingly specific keys:
 *   1. defaults (global)
 *   2. segment-level override
 *   3. segment.phase-level override
 *   4. segment.phase.step-level override (most specific wins)
 */
export function resolveProfile(
	config: CuiConfig,
	segment: string,
	phase: string,
	step: string,
): LLMProfile {
	const keys = [`${segment}.${phase}.${step}`, `${segment}.${phase}`, segment];

	let profile: LLMProfile = { ...config.defaults };
	for (const key of keys) {
		const override = config.profiles[key];
		if (override) {
			profile = mergeProfile(config.defaults, override);
			break;
		}
	}

	// Model-keyed pricing: inline profile.pricing wins; otherwise look up by
	// the resolved model so every occurrence of a model is priced the same.
	if (!profile.pricing && config.modelPricing?.[profile.model]) {
		profile = { ...profile, pricing: config.modelPricing[profile.model] };
	}

	// Model-keyed max output tokens — same pattern as pricing.
	if (
		profile.maxTokens === undefined &&
		config.modelMaxTokens?.[profile.model]
	) {
		profile = { ...profile, maxTokens: config.modelMaxTokens[profile.model] };
	}

	return profile;
}

function mergeProfile(
	base: LLMProfile,
	override: Partial<LLMProfile>,
): LLMProfile {
	return {
		provider: override.provider ?? base.provider,
		model: override.model ?? base.model,
		maxTurns: override.maxTurns ?? base.maxTurns,
		maxTokens: override.maxTokens ?? base.maxTokens,
		env: override.env ? { ...base.env, ...override.env } : base.env,
		pricing: override.pricing ?? base.pricing,
	};
}
