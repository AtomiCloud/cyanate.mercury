/**
 * Pure: wireframe output validation.
 *
 * Composes validators from src/lib/validators.ts into a single
 * validation function that checks all wireframe invariants.
 *
 * All functions are pure (data in → errors out). No IO.
 */

import {
	findLeakedAbsoluteUrls,
	validateAssetIntegrity,
	validateContentCoverage,
} from "../../lib/validators.js";
import type { PageContent } from "../../types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidateWireframeInput {
	sourcePages: PageContent[];
	generatedRoutes: string[];
	assetManifest: Record<string, string>;
	existingImageFiles: string[];
	astroFileContents: Record<string, string>;
	originalSiteUrl: string;
	pagefindExists: boolean;
}

export interface ValidateWireframeResult {
	valid: boolean;
	errors: string[];
}

/**
 * Composite validation for wireframe Phase 5.
 * Checks all invariants and collects all errors.
 */
export function validateWireframeOutput(
	input: ValidateWireframeInput,
): ValidateWireframeResult {
	const errors: string[] = [];

	// 1. Content coverage: every source page has a route
	const coverage = validateContentCoverage(
		input.sourcePages,
		input.generatedRoutes,
	);
	if (coverage.missing.length > 0) {
		errors.push(
			`Content coverage: ${coverage.missing.length} pages missing routes: ${coverage.missing.slice(0, 5).join(", ")}${coverage.missing.length > 5 ? "..." : ""}`,
		);
	}

	// 2. Asset integrity: manifest entries have files
	const integrity = validateAssetIntegrity(
		input.assetManifest,
		input.existingImageFiles,
	);
	if (integrity.missing.length > 0) {
		errors.push(
			`Asset integrity: ${integrity.missing.length} manifest entries missing files: ${integrity.missing.slice(0, 5).join(", ")}${integrity.missing.length > 5 ? "..." : ""}`,
		);
	}

	// 3. No leaked absolute URLs from original site
	const leakedUrls = findLeakedAbsoluteUrls(
		input.astroFileContents,
		input.originalSiteUrl,
	);
	for (const leak of leakedUrls) {
		errors.push(
			`Leaked absolute URL in ${leak.file}:${leak.line}: ${leak.url}`,
		);
	}

	// 4. Pagefind directory must exist
	if (!input.pagefindExists) {
		errors.push(
			"Pagefind directory not found — required for search functionality",
		);
	}

	return { valid: errors.length === 0, errors };
}
