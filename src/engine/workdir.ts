/**
 * Workdir management for iterations.
 *
 * - Each iteration gets its own directory under the segment run dir
 * - Phase transitions copy the previous iteration's workdir
 * - Phase retries copy from the FAILED iteration (preserving partial work)
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Build the iteration directory name.
 * Format: iteration-{index}-{phaseId}
 */
function iterationDirName(index: number, phaseId: string): string {
	return `iteration-${index}-${phaseId}`;
}

/**
 * Create a new iteration directory by copying from a source.
 *
 * @param segmentDir - Root dir for the segment (runs/<run-id>/<segment-id>/)
 * @param index - Iteration index (1-based)
 * @param phaseId - Phase identifier
 * @param sourceDir - Directory to copy from (previous iteration's workdir), or null for first iteration
 * @returns Absolute path to the new iteration workdir
 */
export async function createIteration(
	segmentDir: string,
	index: number,
	phaseId: string,
	sourceDir: string | null,
): Promise<string> {
	const dirName = iterationDirName(index, phaseId);
	const iterDir = join(segmentDir, dirName);

	if (sourceDir) {
		await cp(sourceDir, iterDir, { recursive: true });
	} else {
		await mkdir(iterDir, { recursive: true });
	}

	return iterDir;
}

/**
 * Find the latest iteration directory in a segment dir.
 */
async function _findLatestIteration(
	segmentDir: string,
): Promise<{ index: number; phaseId: string; path: string } | null> {
	let entries: string[];
	try {
		entries = await readdir(segmentDir);
	} catch {
		return null;
	}

	const iterDirs = entries
		.filter((e) => e.startsWith("iteration-"))
		.flatMap((e) => {
			const match = e.match(/^iteration-(\d+)-(.+)$/);
			if (!match) return [];
			return [
				{
					index: Number.parseInt(match[1], 10),
					phaseId: match[2],
					path: join(segmentDir, e),
				},
			];
		})
		.sort((a, b) => b.index - a.index);

	return iterDirs[0] ?? null;
}

/**
 * Create the run directory structure.
 */
export async function createRunDir(
	rootDir: string,
	runId: string,
): Promise<string> {
	const runDir = join(rootDir, "runs", runId);
	await mkdir(runDir, { recursive: true });
	return runDir;
}

/**
 * Create the segment directory within a run.
 */
export async function createSegmentDir(
	runDir: string,
	segmentId: string,
): Promise<string> {
	const segDir = join(runDir, segmentId);
	await mkdir(segDir, { recursive: true });
	return segDir;
}
