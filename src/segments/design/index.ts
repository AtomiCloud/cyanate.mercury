/**
 * Design segment registration.
 *
 * Segment 3 (FR-6): Applies analyze's design tokens to wireframe's
 * unstyled Astro project, producing a fully styled site.
 * Depends on: analyze, wireframe
 */

import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import { buildMergePlan } from "./merge-inputs.js";
import {
	colorPhase,
	layoutPhase,
	motionPhase,
	qaPhase,
	tokenPhase,
	typographyPhase,
} from "./phases.io.js";

// ---------------------------------------------------------------------------
// Merge plan execution (IO)
// ---------------------------------------------------------------------------

/**
 * Execute the merge plan — copy files from dependencies into workdir.
 * Uses actual dependency output paths provided by the engine.
 */
async function executeMergePlan(
	workdir: string,
	plan: NonNullable<ReturnType<typeof buildMergePlan>>,
	deps: Record<string, string>,
): Promise<void> {
	await mkdir(workdir, { recursive: true });

	for (const copy of plan.copies) {
		const depOutputDir = deps[copy.depId];
		if (!depOutputDir) {
			console.warn(
				`[design:mergeInputs] No output path for dependency "${copy.depId}"`,
			);
			continue;
		}
		const fromPath = join(depOutputDir, copy.from);
		const toPath = join(workdir, copy.to);

		try {
			await cp(fromPath, toPath, { recursive: true });
		} catch (err) {
			// If a specific file doesn't exist, warn but continue
			console.warn(
				`[design:mergeInputs] Failed to copy ${copy.from} from ${copy.depId}: ${String(err)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Segment registration
// ---------------------------------------------------------------------------

const designSegment: SegmentDef = {
	id: "design",
	name: "Design",
	description:
		"Apply design tokens from analyze to wireframe's Astro project — produces styled site with WCAG-compliant colors and layer isolation",
	depends: ["analyze", "wireframe"],
	phases: [
		tokenPhase, // Token injection + Shadcn setup
		layoutPhase, // Layout layer
		typographyPhase, // Typography + surfaces
		colorPhase, // Color + dark mode
		motionPhase, // Motion + transitions
		qaPhase, // Final QA
	],
	mergeInputs: async (workdir, deps, _config) => {
		// Plan is pure, execution is IO
		const plan = buildMergePlan(deps);
		await executeMergePlan(workdir, plan, deps);
	},
	extractOutput: async (workdir, outputDir) => {
		await mkdir(outputDir, { recursive: true });

		// Copy the styled project
		const projectDir = join(workdir, "project");
		try {
			await cp(projectDir, join(outputDir, "project"), {
				recursive: true,
			});
		} catch (err) {
			console.warn(
				`[design:extractOutput] Failed to copy project/: ${String(err)}`,
			);
		}

		// Copy quality scores if present
		try {
			await cp(
				join(workdir, "quality-scores.json"),
				join(outputDir, "quality-scores.json"),
			);
		} catch {
			// May not exist yet
		}
	},
};

registry.register(designSegment);
