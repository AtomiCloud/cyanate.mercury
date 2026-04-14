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
	result: {
		success: boolean;
		error?: { issues: Array<{ message: string; path?: PropertyKey[] }> };
	},
	prefix: string,
): string[] {
	if (result.success) return [];
	return (result.error?.issues ?? []).map((i) => {
		const path = i.path?.length ? `.${i.path.join(".")}` : "";
		return `${prefix}${path}: ${i.message}`;
	});
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
 * Validate design outputs only (fingerprint + tokens).
 *
 * Used by the extract-design phase where component recipes
 * haven't been produced yet.
 */
export function validateDesignOutputs(
	fingerprint: unknown,
	tokens: unknown,
): ValidationResult {
	const errors: string[] = [];

	const fpResult = StyleFingerprintSchema.safeParse(fingerprint);
	const tokResult = DesignTokensV2Schema.safeParse(tokens);

	errors.push(...collectZodErrors(fpResult, "fingerprint"));
	errors.push(...collectZodErrors(tokResult, "tokens"));

	if (tokResult.success) {
		const tok = tokens as DesignTokensV2;
		errors.push(...validateSpacingScale(tok));
		errors.push(...validateTypographyScale(tok));
		errors.push(...validateOklchValues(tok));
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Validate component recipes only.
 *
 * Used by the discover-components phase.
 */
export function validateComponentRecipes(recipes: unknown): ValidationResult {
	const errors: string[] = [];

	const recResult = ComponentRecipesSchema.safeParse(recipes);
	errors.push(...collectZodErrors(recResult, "recipes"));

	if (recResult.success) {
		errors.push(...checkComponentBases(recipes));
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Run all analyze output validation checks.
 *
 * Composes validateDesignOutputs + validateComponentRecipes.
 */
export function validateAnalyzeOutputs(
	outputs: ValidateAnalyzeOutputsInput,
): ValidationResult {
	const design = validateDesignOutputs(outputs.fingerprint, outputs.tokens);
	const components = validateComponentRecipes(outputs.recipes);
	return {
		valid: design.valid && components.valid,
		errors: [...design.errors, ...components.errors],
	};
}
