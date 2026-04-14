/**
 * Fork + Merge: parallel agent isolation via workdir copies.
 *
 * Creates isolated copies of a workdir so multiple agents can modify files
 * concurrently, then diffs and merges changes back to the original.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileChange, ForkPlan, MergeResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Segments to skip when walking / copying. */
const SKIP_SEGMENTS = new Set(["node_modules", ".astro"]);

/** Return true if any segment of the relative path matches a skip name. */
function hasSkipSegment(relPath: string): boolean {
	return relPath.split(sep).some((s) => SKIP_SEGMENTS.has(s));
}

/**
 * Recursively walk `dir`, returning relative paths of all files.
 * Skips `node_modules/` and `.astro/` directories.
 */
async function walkFiles(dir: string): Promise<string[]> {
	const results: string[] = [];

	async function walk(current: string): Promise<void> {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (SKIP_SEGMENTS.has(entry.name)) continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				results.push(relative(dir, full));
			}
		}
	}

	await walk(dir);
	return results;
}

/**
 * Compute a sha256 manifest for every file under `dir`.
 * Returns Map<relative path, hex hash>.
 */
export async function computeManifest(
	dir: string,
): Promise<Map<string, string>> {
	const manifest = new Map<string, string>();
	const files = await walkFiles(dir);

	for (const rel of files) {
		const content = await readFile(join(dir, rel));
		const hash = createHash("sha256").update(content).digest("hex");
		manifest.set(rel, hash);
	}

	return manifest;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create isolated fork copies of `workdir`, one per id.
 *
 * Each fork lives at `<parent of workdir>/iteration-<N>-fork-<id>`.
 * Forks are kept after merge for audit/debugging (not auto-deleted).
 * If a fork contains `project/package.json`, runs `bun install --frozen-lockfile` there.
 */
export async function createForks(
	workdir: string,
	ids: string[],
	iterationIndex: number,
): Promise<ForkPlan> {
	const manifest = await computeManifest(workdir);

	const forks: Array<{ id: string; dir: string }> = [];

	for (const id of ids) {
		const forkDir = join(
			dirname(workdir),
			`iteration-${iterationIndex}-fork-${id}`,
		);

		await cp(workdir, forkDir, {
			recursive: true,
			filter: (source: string) => {
				const rel = relative(workdir, source);
				// root dir itself has rel === "", always include
				if (rel === "") return true;
				return !hasSkipSegment(rel);
			},
		});

		// Install dependencies if project/package.json exists
		const projectPkg = join(forkDir, "project", "package.json");
		try {
			await stat(projectPkg);
		} catch {
			// No project/package.json — skip install
			forks.push({ id, dir: forkDir });
			continue;
		}
		execSync("bun install --frozen-lockfile", {
			cwd: join(forkDir, "project"),
			stdio: "pipe",
		});

		forks.push({ id, dir: forkDir });
	}

	return { originalDir: workdir, manifest, forks };
}

/**
 * Diff a single fork against the original manifest.
 *
 * Returns file changes: adds, modifications, and deletions.
 */
export async function diffFork(
	plan: ForkPlan,
	forkId: string,
): Promise<FileChange[]> {
	const fork = plan.forks.find((f) => f.id === forkId);
	if (!fork) throw new Error(`Fork "${forkId}" not found in plan`);

	const forkManifest = await computeManifest(fork.dir);
	const changes: FileChange[] = [];

	// Added or modified files
	for (const [path, hash] of forkManifest) {
		const originalHash = plan.manifest.get(path);
		if (originalHash === undefined) {
			changes.push({ path, type: "add", forkId });
		} else if (originalHash !== hash) {
			changes.push({ path, type: "modify", forkId });
		}
	}

	// Deleted files
	for (const path of plan.manifest.keys()) {
		if (!forkManifest.has(path)) {
			changes.push({ path, type: "delete", forkId });
		}
	}

	return changes;
}

/**
 * Collect diffs from all forks and group changes by file path.
 * Returns a map of path to the list of changes from different forks.
 */
function groupChangesByPath(
	allChanges: FileChange[],
): Map<string, FileChange[]> {
	const byPath = new Map<string, FileChange[]>();
	for (const change of allChanges) {
		const existing = byPath.get(change.path);
		if (existing) {
			existing.push(change);
		} else {
			byPath.set(change.path, [change]);
		}
	}
	return byPath;
}

/**
 * Apply a list of non-conflicting file changes from forks into the original dir.
 */
async function applyChanges(
	changes: FileChange[],
	plan: ForkPlan,
): Promise<void> {
	for (const change of changes) {
		const fork = plan.forks.find((f) => f.id === change.forkId);
		if (!fork) continue;

		const destPath = join(plan.originalDir, change.path);

		if (change.type === "delete") {
			await rm(destPath, { force: true });
		} else {
			const srcPath = join(fork.dir, change.path);
			await mkdir(dirname(destPath), { recursive: true });
			const content = await readFile(srcPath);
			await writeFile(destPath, content);
		}
	}
}

/**
 * Merge all forks back into the original workdir.
 *
 * Non-overlapping changes are applied directly. If two or more forks
 * touch the same path the merge reports a conflict.
 */
export async function mergeForks(plan: ForkPlan): Promise<MergeResult> {
	// Collect diffs from every fork
	const allChanges: FileChange[] = [];
	for (const fork of plan.forks) {
		const diff = await diffFork(plan, fork.id);
		allChanges.push(...diff);
	}

	const byPath = groupChangesByPath(allChanges);

	// Partition into conflicts and clean changes
	const conflicts: Array<{ path: string; forkIds: string[] }> = [];
	const toApply: FileChange[] = [];

	for (const [path, changes] of byPath) {
		if (changes.length > 1) {
			conflicts.push({ path, forkIds: changes.map((c) => c.forkId) });
		} else {
			toApply.push(changes[0]);
		}
	}

	if (conflicts.length > 0) {
		return { status: "conflict", applied: [], conflicts };
	}

	await applyChanges(toApply, plan);
	return { status: "clean", applied: toApply };
}

/**
 * Remove all fork directories.
 */
export async function cleanupForks(plan: ForkPlan): Promise<void> {
	for (const fork of plan.forks) {
		await rm(fork.dir, { recursive: true, force: true });
	}
}
