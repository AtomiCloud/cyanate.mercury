/**
 * Shared filesystem helpers for the harmonize phases.
 *
 * Each harmonize phase fans out across pagetypes and reads/writes under
 * `classify-output/<pagetype>/`. These helpers enumerate pagetype directories
 * and load the digest that 3a produced.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	PageTypeDigest,
	StructuralSignals,
} from "../lib/harmonize-types.js";

export interface PagetypeDir {
	pagetype: string;
	outDir: string;
}

/**
 * Enumerate `classify-output/*` directories that contain a `digest.json`
 * (i.e. pagetypes that harmonize-prepare produced output for).
 */
export async function discoverPagetypeDirs(
	workdir: string,
): Promise<PagetypeDir[]> {
	const root = join(workdir, "classify-output");
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return [];
	}
	const out: PagetypeDir[] = [];
	for (const entry of entries) {
		const outDir = join(root, entry);
		try {
			const st = await stat(outDir);
			if (!st.isDirectory()) continue;
			await stat(join(outDir, "digest.json"));
			out.push({ pagetype: entry, outDir });
		} catch {
			// no digest — skip
		}
	}
	out.sort((a, b) =>
		a.pagetype < b.pagetype ? -1 : a.pagetype > b.pagetype ? 1 : 0,
	);
	return out;
}

export async function readDigest(outDir: string): Promise<PageTypeDigest> {
	const raw = await readFile(join(outDir, "digest.json"), "utf-8");
	return JSON.parse(raw) as PageTypeDigest;
}

/**
 * Optional sidecar produced by harmonize-prepare. Missing file means "no
 * signals available" — callers should tolerate `null`, not fail. The aligner
 * only needs signals to validate `element-key` ops; without them, such ops
 * pass structural checks and fail at runtime if element identity is unsound.
 */
export async function readSignals(
	outDir: string,
): Promise<StructuralSignals | null> {
	try {
		const raw = await readFile(
			join(outDir, "structural-signals.json"),
			"utf-8",
		);
		return JSON.parse(raw) as StructuralSignals;
	} catch {
		return null;
	}
}
