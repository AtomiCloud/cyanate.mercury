/**
 * CLI: dry-run normalize + validate for design tokens.
 *
 * Used by the extract-design agent to self-check its output before
 * finalizing. Normalizes in memory (no file writes), validates against
 * Zod schemas + domain rules, and prints path-enriched errors.
 *
 * Usage: bun run src/segments/analyze/validate-tokens-cli.ts <workdir>
 * Exit 0 on PASS, exit 1 on validation errors.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRawTokens } from "./merge.js";
import { validateDesignOutputs } from "./validate.js";

async function main() {
	const workdir = process.argv[2];
	if (!workdir) {
		console.error("Usage: bun run validate-tokens-cli.ts <workdir>");
		process.exit(2);
	}

	const fpPath = join(workdir, "_raw-fingerprint.json");
	const tokPath = join(workdir, "_raw-tokens.json");

	let rawFingerprint: unknown;
	let rawTokens: unknown;

	try {
		rawFingerprint = JSON.parse(await readFile(fpPath, "utf-8"));
	} catch {
		console.error(`ERROR: Cannot read or parse ${fpPath}`);
		process.exit(1);
	}

	try {
		rawTokens = JSON.parse(await readFile(tokPath, "utf-8"));
	} catch {
		console.error(`ERROR: Cannot read or parse ${tokPath}`);
		process.exit(1);
	}

	const normalized = normalizeRawTokens(rawTokens as Record<string, unknown>);
	const result = validateDesignOutputs(rawFingerprint, normalized);

	if (result.valid) {
		console.log("PASS");
		process.exit(0);
	}

	for (const err of result.errors) {
		console.log(err);
	}
	process.exit(1);
}

main();
