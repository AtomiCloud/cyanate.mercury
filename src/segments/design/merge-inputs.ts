/**
 * Pure: merge input planning.
 *
 * Computes what needs to be copied from analyze + wireframe dependency
 * outputs into the design segment's initial workdir. No IO — pure plan only.
 */

import type { MergePlan } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files expected from the analyze segment */
const ANALYZE_FILES = [
	"style-fingerprint.json",
	"design-tokens.json",
	"component-recipes.json",
] as const;

/** Directories expected from the analyze segment */
const ANALYZE_DIRS = ["patterns"] as const;

/** Files expected from the wireframe segment */
const WIREFRAME_FILES = [
	"registry.json",
	"content-model.json",
	"component-manifest.json",
	"asset-manifest.json",
	"reduced-meta.json",
] as const;

/** Directories expected from the wireframe segment */
const WIREFRAME_DIRS = ["project"] as const;

// ---------------------------------------------------------------------------
// Merge plan building
// ---------------------------------------------------------------------------

/**
 * Add copy entries for a list of files.
 */
function addFileCopies(
	copies: MergePlan["copies"],
	depId: string,
	files: readonly string[],
): void {
	for (const file of files) {
		copies.push({ from: file, to: file, depId });
	}
}

/**
 * Add copy entries for a list of directories.
 */
function addDirCopies(
	copies: MergePlan["copies"],
	depId: string,
	dirs: readonly string[],
): void {
	for (const dir of dirs) {
		copies.push({ from: dir, to: dir, depId });
	}
}

/**
 * Build a merge plan from dependency outputs.
 *
 * Analyzes which files/dirs exist in each dependency output and produces
 * copy entries for everything the design segment needs.
 */
export function buildMergePlan(deps: Record<string, string>): MergePlan {
	const copies: MergePlan["copies"] = [];

	for (const [depId] of Object.entries(deps)) {
		if (depId === "analyze") {
			addFileCopies(copies, depId, ANALYZE_FILES);
			addDirCopies(copies, depId, ANALYZE_DIRS);
		} else if (depId === "wireframe") {
			addFileCopies(copies, depId, WIREFRAME_FILES);
			addDirCopies(copies, depId, WIREFRAME_DIRS);
		}
	}

	return { copies, errors: [] };
}

// ---------------------------------------------------------------------------
// Merge plan validation
// ---------------------------------------------------------------------------

/**
 * Validate that a merge plan has all expected inputs.
 *
 * Returns { valid, missing } where missing lists any expected files
 * that are not in the plan's copies.
 */
export function validateMergePlan(
	plan: MergePlan,
	expectedAnalyzeOutputs: string[],
	expectedWireframeOutputs: string[],
): { valid: boolean; missing: string[] } {
	const copiedFiles = new Set(plan.copies.map((c) => c.to));
	const missing: string[] = [];

	for (const file of expectedAnalyzeOutputs) {
		if (!copiedFiles.has(file)) {
			missing.push(`analyze:${file}`);
		}
	}

	for (const file of expectedWireframeOutputs) {
		if (!copiedFiles.has(file)) {
			missing.push(`wireframe:${file}`);
		}
	}

	return { valid: missing.length === 0, missing };
}
