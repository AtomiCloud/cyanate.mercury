/**
 * `mecury check normalization <unit-dir>` — self-verification CLI that the
 * A0 normalization agent invokes after writing `agent-output.json`.
 *
 * Expected layout:
 *   <hashDir>/content.json                         ← source { url, pagetype, content }
 *   <hashDir>/normalize/attempt-<N>/agent-output.json  ← `<unit-dir>` points here
 *
 * Exit codes: 0 = valid, 1 = invalid normalization, 2 = missing / unreadable input.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PreparedPage } from "../prepare/ingest.js";
import {
	checkNormalization,
	parseNormalizationFromAgent,
} from "./per-page-classify.js";

interface UnitContent {
	url: string;
	pagetype: string;
	content: Record<string, unknown>;
}

export async function checkNormalizationCli(unitDir: string): Promise<number> {
	const attemptDir = resolve(unitDir);
	const hashDir = dirname(dirname(attemptDir)); // .../classify-input/<hash>

	let agentRaw: string;
	try {
		agentRaw = await readFile(join(attemptDir, "agent-output.json"), "utf-8");
	} catch (err) {
		console.error(
			`Cannot read agent-output.json in ${attemptDir}: ${String(err)}`,
		);
		return 2;
	}

	let unit: UnitContent;
	try {
		const raw = await readFile(join(hashDir, "content.json"), "utf-8");
		unit = JSON.parse(raw) as UnitContent;
	} catch (err) {
		console.error(`Cannot read content.json in ${hashDir}: ${String(err)}`);
		return 2;
	}

	const page: PreparedPage = {
		url: unit.url,
		pagetype: unit.pagetype,
		content: unit.content,
		schema: {},
	};

	const parsed = parseNormalizationFromAgent(agentRaw, page);
	if (!parsed) {
		console.error(
			"agent-output.json could not be parsed as a valid normalization JSON",
		);
		return 1;
	}

	const check = checkNormalization(parsed, unit.content);
	if (check.valid) {
		console.log(`OK: normalization valid for ${unit.url}`);
		return 0;
	}

	const lines: string[] = [`FAIL: normalization invalid for ${unit.url}`];
	if (check.missing.length > 0) {
		lines.push(
			`  missing ${check.missing.length}/${check.expectedPaths.length} leaf path(s): ${check.missing.slice(0, 20).join(", ")}`,
		);
	}
	if (check.extra.length > 0) {
		lines.push(
			`  extra ${check.extra.length} path(s) not in content: ${check.extra.slice(0, 20).join(", ")}`,
		);
	}
	for (const e of check.typeErrors.slice(0, 20)) lines.push(`  type: ${e}`);
	for (const e of check.roundTripErrors.slice(0, 20)) {
		lines.push(`  round-trip: ${e}`);
	}
	console.error(lines.join("\n"));
	return 1;
}
