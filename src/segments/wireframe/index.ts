/**
 * Wireframe segment registration.
 *
 * Transforms classified content into a working unstyled Astro project.
 * Depends on classify — receives classify's output (registry, content-model,
 * resolved-entries, etc.) via mergeInputs.
 *
 * Note: the existing phases (reduce/classify/seed/generate/validate) still
 * read raw scraper files via ctx.config.input. Full phase refactor per
 * new/wireframe.md §4 (seed/generate-layouts/generate-components/
 * generate-pages/content-gate) is deferred; this change only wires the DAG
 * edge so run.json identity inheritance works correctly.
 */

import { copyFile, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import {
	classifyPhase,
	generatePhase,
	reducePhase,
	seedPhase,
	validatePhase,
} from "./phases.io.js";

const wireframeSegment: SegmentDef = {
	id: "wireframe",
	name: "Wireframe",
	description:
		"Transform classified content into an unstyled Astro project with content collections, routes, and wireframe components",
	depends: ["classify"],
	phases: [reducePhase, classifyPhase, seedPhase, generatePhase, validatePhase],
	mergeInputs: async (workdir, deps) => {
		const classifyPath = deps.classify;
		if (!classifyPath) return;

		const files = [
			// Core classified artifacts
			"registry.json",
			"globals.json",
			"shared-components.json",
			"field-classifications.json",
			"render-maps.json",
			"content-model-classified.json",
			"content-model.json",
			// Adapter-ready bundle
			"resolved-entries.json",
			"asset-manifest.json",
			// Prepare pass-throughs (classify re-exports these)
			"pages.json",
			"page-type-meta.json",
			"prepared-content.json",
		];

		for (const file of files) {
			try {
				await cp(join(classifyPath, file), join(workdir, file));
			} catch {
				// Not all files may exist — not fatal at merge time
			}
		}
	},
	extractOutput: async (workdir, outputDir) => {
		await mkdir(outputDir, { recursive: true });

		// Copy the Astro project
		const projectDir = join(workdir, "project");
		try {
			await cp(projectDir, join(outputDir, "project"), {
				recursive: true,
			});
		} catch (err) {
			console.warn(
				`[wireframe:extractOutput] Failed to copy project/: ${String(err)}`,
			);
		}

		// Copy manifest files
		const manifestFiles = [
			"registry.json",
			"content-model.json",
			"asset-manifest.json",
			"reduced-meta.json",
			"registry-draft.json",
			"listing-pairings.json",
		];
		for (const file of manifestFiles) {
			try {
				await copyFile(join(workdir, file), join(outputDir, file));
			} catch {
				// Manifest may not exist
			}
		}
	},
};

registry.register(wireframeSegment);
