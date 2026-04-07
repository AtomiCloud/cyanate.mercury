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

	for (const key of keys) {
		const override = config.profiles[key];
		if (override) {
			return mergeProfile(config.defaults, override);
		}
	}

	return { ...config.defaults };
}

function mergeProfile(
	base: LLMProfile,
	override: Partial<LLMProfile>,
): LLMProfile {
	return {
		provider: override.provider ?? base.provider,
		model: override.model ?? base.model,
		maxTurns: override.maxTurns ?? base.maxTurns,
		env: override.env ? { ...base.env, ...override.env } : base.env,
	};
}
