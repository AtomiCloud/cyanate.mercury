/**
 * Phase 1 — `classify-prepare`
 *
 * Single programmatic step: materialize per-page `content.json` into
 * `classify-input/<hash>/` so every downstream fan-out phase has a stable
 * on-disk input surface.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseDef } from "../../../engine/types.js";
import { programmaticStep } from "../../../steps/step.js";
import type { PreparedPage } from "../../prepare/ingest.js";
import { classifyUnitHash } from "../per-page-classify.js";

async function readJson<T>(workdir: string, filename: string): Promise<T> {
	const raw = await readFile(join(workdir, filename), "utf-8");
	return JSON.parse(raw) as T;
}

export const classifyPreparePhase: PhaseDef = {
	id: "classify-prepare",
	name: "Classify prepare",
	description: "Write content.json per page into classify-input/<hash>/",
	maxRetries: 1,
	steps: [
		programmaticStep({
			id: "write-classify-inputs",
			name: "Write classify inputs",
			description:
				"Materialize classify-input/<hash>/content.json for every page",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const { pages } = await readJson<{ pages: PreparedPage[] }>(
						ctx.workdir,
						"prepared-content.json",
					);

					for (const page of pages) {
						const hash = classifyUnitHash(page.url);
						const dir = join(ctx.workdir, "classify-input", hash);
						await mkdir(dir, { recursive: true });
						await writeFile(
							join(dir, "content.json"),
							JSON.stringify(
								{
									url: page.url,
									pagetype: page.pagetype,
									content: page.content,
								},
								null,
								2,
							),
						);
					}
					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `write-classify-inputs failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};
