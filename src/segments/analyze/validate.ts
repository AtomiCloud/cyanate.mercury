/**
 * Pure: analyze-specific validation rules.
 *
 * Composes Zod schemas and domain validators from src/lib/validators.ts
 * into a single function that validates all analyze outputs.
 */

import {
	ComponentRecipesSchema,
	DesignTokensV2Schema,
	StyleFingerprintSchema,
	validateOklchValues,
	validateSpacingScale,
	validateTypographyScale,
} from "../../lib/validators.js";
import type { DesignTokensV2 } from "../../types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidateAnalyzeOutputsInput {
	fingerprint: unknown;
	tokens: unknown;
	recipes: unknown;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

function collectZodErrors(
	result: { success: boolean; error?: { issues: Array<{ message: string }> } },
	prefix: string,
): string[] {
	if (result.success) return [];
	return (result.error?.issues ?? []).map((i) => `${prefix}: ${i.message}`);
}

function checkComponentBases(recipes: unknown): string[] {
	const errors: string[] = [];
	if (!recipes || typeof recipes !== "object") return errors;
	for (const [name, recipe] of Object.entries(
		recipes as Record<string, unknown>,
	)) {
		if (!recipe || typeof recipe !== "object" || !("base" in recipe)) {
			errors.push(`component "${name}" missing base recipe`);
		}
	}
	return errors;
}

/**
 * Run all analyze output validation checks.
 *
 * Validates:
 * - StyleFingerprint Zod schema
 * - DesignTokensV2 Zod schema
 * - ComponentRecipes Zod schema
 * - Domain rules (spacing scale, typography scale, OKLCH values)
 */
export function validateAnalyzeOutputs(
	outputs: ValidateAnalyzeOutputsInput,
): ValidationResult {
	const errors: string[] = [];

	const fpResult = StyleFingerprintSchema.safeParse(outputs.fingerprint);
	const tokResult = DesignTokensV2Schema.safeParse(outputs.tokens);
	const recResult = ComponentRecipesSchema.safeParse(outputs.recipes);

	errors.push(...collectZodErrors(fpResult, "fingerprint"));
	errors.push(...collectZodErrors(tokResult, "tokens"));
	errors.push(...collectZodErrors(recResult, "recipes"));

	if (tokResult.success) {
		const tokens = outputs.tokens as DesignTokensV2;
		errors.push(...validateSpacingScale(tokens));
		errors.push(...validateTypographyScale(tokens));
		errors.push(...validateOklchValues(tokens));
	}

	if (recResult.success) {
		errors.push(...checkComponentBases(outputs.recipes));
	}

	return { valid: errors.length === 0, errors };
}
