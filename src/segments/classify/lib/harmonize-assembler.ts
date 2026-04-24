/**
 * Deterministic assembler — builds the canonical chrome tree and per-page
 * mappers from a (validated) verdict table. This is the step that was
 * previously entangled with LLM judgment; here it's pure.
 *
 * The assembler does NOT re-run LLM judgment validators. Callers are expected
 * to have run `validateRenameTable` + `validateVerdicts` first. The assembler
 * surfaces its own errors only when a structural invariant it depends on
 * fails (bad input from upstream).
 */

import {
	type CanonicalTree,
	CHROME_DYNAMIC_SENTINEL,
	type ChromeDynamic,
	type ChromeDynamicSlot,
	type PageMapper,
	type PageMapperEntry,
	type PageTypeDigest,
	type RenameTable,
	type ValidationResult,
	type Verdict,
	type VerdictTable,
} from "./harmonize-types.js";
import { readPath } from "./path-utils.js";

export interface AssembleInput {
	pagetype: string;
	/** Post-rename digest — candidates are already folded. */
	renamedDigest: PageTypeDigest;
	verdicts: VerdictTable;
	/**
	 * The pre-rename digest + the rename table — needed to emit per-page mappers
	 * with the original `sourcePath` → canonical mapping, and to source per-page
	 * values for keep-dynamic slots.
	 */
	preRenameDigest: PageTypeDigest;
	renameTable: RenameTable;
	/** Per-page content, keyed by page hash. Used to resolve sourcePaths for mappers. */
	pageContents: Map<
		string,
		{
			url: string;
			content: unknown;
			sourcePaths: Array<{ sourcePath: string; candidatePath: string }>;
		}
	>;
}

export interface ChromeFields {
	[canonicalField: string]: unknown;
}

export interface ValueConflictReport {
	candidatePath: string;
	verdict: Verdict["kind"];
	distinctValues: Array<{ value: unknown; pageHashes: string[] }>;
	rationale?: string;
	chosenValue?: unknown;
}

export interface HarmonizeMeta {
	pagetype: string;
	totalPages: number;
	verdictCounts: Record<Verdict["kind"], number>;
	absent: Array<{ canonicalField: string; pageHashes: string[] }>;
	renameCount: number;
}

export interface AssembleResult {
	canonical: CanonicalTree;
	chromeFields: ChromeFields;
	chromeDynamic: ChromeDynamic;
	valueConflicts: ValueConflictReport[];
	meta: HarmonizeMeta;
	pageMappers: PageMapper[];
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export function assemble(input: AssembleInput): AssembleResult {
	const verdictByPath = new Map(
		input.verdicts.map((v) => [v.candidatePath, v]),
	);
	const renameMap = buildRenameMap(input.renameTable);
	const resolveTarget = (path: string): string =>
		followRenameChain(path, renameMap);

	const { canonical, chromeFields, chromeDynamic } = buildChromeStructures(
		input.verdicts,
		input.preRenameDigest,
		resolveTarget,
	);
	const pageMappers = buildPageMappers(
		input.pageContents,
		input.renamedDigest.pagetype,
		verdictByPath,
		resolveTarget,
	);
	const valueConflicts = buildValueConflicts(
		input.renamedDigest,
		verdictByPath,
	);
	const meta = buildMeta(
		input.renamedDigest,
		input.verdicts,
		input.renameTable,
	);

	return {
		canonical,
		chromeFields,
		chromeDynamic,
		valueConflicts,
		meta,
		pageMappers,
	};
}

function buildRenameMap(renameTable: RenameTable): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of renameTable) map.set(entry.from, entry.to);
	return map;
}

function followRenameChain(
	path: string,
	renameMap: Map<string, string>,
): string {
	let cursor = path;
	const seen = new Set<string>();
	while (renameMap.has(cursor)) {
		if (seen.has(cursor)) break;
		seen.add(cursor);
		cursor = renameMap.get(cursor) as string;
	}
	return cursor;
}

interface ChromeStructures {
	canonical: CanonicalTree;
	chromeFields: ChromeFields;
	chromeDynamic: ChromeDynamic;
}

function buildChromeStructures(
	verdicts: VerdictTable,
	preRenameDigest: PageTypeDigest,
	resolveTarget: (path: string) => string,
): ChromeStructures {
	const canonical: CanonicalTree = {};
	const chromeFields: ChromeFields = {};
	const chromeDynamic: ChromeDynamic = {};
	for (const v of verdicts) {
		if (v.kind === "keep-static") {
			placeAtPath(canonical, v.candidatePath, v.value);
			chromeFields[v.candidatePath] = v.value;
		} else if (v.kind === "keep-dynamic") {
			placeAtPath(canonical, v.candidatePath, CHROME_DYNAMIC_SENTINEL);
			chromeFields[v.candidatePath] = CHROME_DYNAMIC_SENTINEL;
			chromeDynamic[v.candidatePath] = buildDynamicSlot(
				v,
				preRenameDigest,
				resolveTarget,
			);
		}
	}
	return { canonical, chromeFields, chromeDynamic };
}

function buildPageMappers(
	pageContents: AssembleInput["pageContents"],
	pagetype: string,
	verdictByPath: Map<string, Verdict>,
	resolveTarget: (path: string) => string,
): PageMapper[] {
	const out: PageMapper[] = [];
	for (const [hash, pageInfo] of pageContents) {
		const { entries, demotedSourcePaths } = partitionSourcePaths(
			pageInfo.sourcePaths,
			verdictByPath,
			resolveTarget,
		);
		out.push({
			hash,
			pagetype,
			entries: entries.sort((a, b) =>
				stringCompare(a.sourcePath, b.sourcePath),
			),
			demotedSourcePaths: demotedSourcePaths.sort(),
		});
	}
	return out;
}

function partitionSourcePaths(
	sourcePaths: Array<{ sourcePath: string; candidatePath: string }>,
	verdictByPath: Map<string, Verdict>,
	resolveTarget: (path: string) => string,
): { entries: PageMapperEntry[]; demotedSourcePaths: string[] } {
	const entries: PageMapperEntry[] = [];
	const demotedSourcePaths: string[] = [];
	for (const { sourcePath, candidatePath } of sourcePaths) {
		const canonicalField = resolveTarget(candidatePath);
		const verdict = verdictByPath.get(canonicalField);
		if (!verdict) {
			demotedSourcePaths.push(sourcePath);
			continue;
		}
		if (verdict.kind === "keep-static" || verdict.kind === "keep-dynamic") {
			entries.push({ sourcePath, canonicalField });
		} else {
			demotedSourcePaths.push(sourcePath);
		}
	}
	return { entries, demotedSourcePaths };
}

function buildValueConflicts(
	renamedDigest: PageTypeDigest,
	verdictByPath: Map<string, Verdict>,
): ValueConflictReport[] {
	const out: ValueConflictReport[] = [];
	for (const cand of renamedDigest.candidates) {
		if (cand.distinctValues.length <= 1) continue;
		const v = verdictByPath.get(cand.candidatePath);
		if (!v) continue;
		out.push(buildConflictReport(cand.candidatePath, cand.distinctValues, v));
	}
	return out;
}

function buildConflictReport(
	candidatePath: string,
	distinctValues: PageTypeDigest["candidates"][number]["distinctValues"],
	verdict: Verdict,
): ValueConflictReport {
	const report: ValueConflictReport = {
		candidatePath,
		verdict: verdict.kind,
		distinctValues: distinctValues.map((d) => ({
			value: d.value,
			pageHashes: [...d.pageHashes],
		})),
	};
	if ("rationale" in verdict && typeof verdict.rationale === "string") {
		report.rationale = verdict.rationale;
	}
	if (verdict.kind === "keep-static" && "value" in verdict) {
		report.chosenValue = verdict.value;
	}
	return report;
}

function buildMeta(
	renamedDigest: PageTypeDigest,
	verdicts: VerdictTable,
	renameTable: RenameTable,
): HarmonizeMeta {
	const verdictCounts: Record<Verdict["kind"], number> = {
		"keep-static": 0,
		"keep-dynamic": 0,
		demote: 0,
		"defer-to-operator": 0,
	};
	const absent: HarmonizeMeta["absent"] = [];
	for (const v of verdicts) {
		verdictCounts[v.kind]++;
		if (v.kind === "keep-static" && v.absentFrom.length > 0) {
			absent.push({
				canonicalField: v.candidatePath,
				pageHashes: [...v.absentFrom],
			});
		}
	}
	return {
		pagetype: renamedDigest.pagetype,
		totalPages: renamedDigest.totalPages,
		verdictCounts,
		absent,
		renameCount: renameTable.length,
	};
}

function stringCompare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function buildDynamicSlot(
	v: Extract<Verdict, { kind: "keep-dynamic" }>,
	preRenameDigest: PageTypeDigest,
	resolveTarget: (path: string) => string,
): ChromeDynamicSlot {
	// Multiple pre-rename candidates can fold into the same canonical via the
	// rename table. Dedup by pageHash — one row per page. If the same page
	// contributed differing values through different source paths, keep the
	// first (deterministic by candidate iteration order) and drop the rest;
	// the divergence is already surfaced in value-conflicts.json upstream.
	const byHash = new Map<string, unknown>();
	for (const cand of preRenameDigest.candidates) {
		if (resolveTarget(cand.candidatePath) !== v.candidatePath) continue;
		for (const dv of cand.distinctValues) {
			for (const ph of dv.pageHashes) {
				if (!byHash.has(ph)) byHash.set(ph, dv.value);
			}
		}
	}
	const values = [...byHash.entries()]
		.map(([pageHash, value]) => ({ pageHash, value }))
		.sort((a, b) =>
			a.pageHash < b.pageHash ? -1 : a.pageHash > b.pageHash ? 1 : 0,
		);
	const absentFrom = preRenameDigest.pageHashes.filter((h) => !byHash.has(h));
	const slot: ChromeDynamicSlot = {
		rationale: v.rationale,
		values,
		absentFrom,
	};
	if (v.pattern !== undefined) slot.pattern = v.pattern;
	return slot;
}

// ---------------------------------------------------------------------------
// Post-assembly validator (belt-and-braces)
// ---------------------------------------------------------------------------

type ValidatePageContents = Map<
	string,
	{
		content: unknown;
		sourcePaths: Array<{ sourcePath: string; candidatePath: string }>;
	}
>;

export function validateAssembled(
	result: AssembleResult,
	verdicts: VerdictTable,
	pageContents: ValidatePageContents,
): ValidationResult {
	const errors: string[] = [];
	for (const v of verdicts) validateVerdictAssembly(v, result, errors);
	for (const mapper of result.pageMappers) {
		validateMapper(mapper, pageContents, result, errors);
	}
	return { valid: errors.length === 0, errors };
}

function validateVerdictAssembly(
	v: Verdict,
	result: AssembleResult,
	errors: string[],
): void {
	if (v.kind === "keep-static" || v.kind === "keep-dynamic") {
		if (!pathResolves(result.canonical, v.candidatePath)) {
			errors.push(
				`canonical tree missing leaf for "${v.kind}" verdict on "${v.candidatePath}" — assembler failed to place the value.`,
			);
		}
	}
	if (v.kind !== "keep-dynamic") return;
	validateDynamicSlot(v.candidatePath, result, errors);
}

function validateDynamicSlot(
	candidatePath: string,
	result: AssembleResult,
	errors: string[],
): void {
	const slot = result.chromeDynamic[candidatePath];
	if (!slot) {
		errors.push(
			`chrome-dynamic missing slot for "keep-dynamic" verdict on "${candidatePath}".`,
		);
		return;
	}
	const presentHashes = new Set(slot.values.map((e) => e.pageHash));
	for (const h of slot.absentFrom) {
		if (presentHashes.has(h)) {
			errors.push(
				`chrome-dynamic slot "${candidatePath}" lists page "${h}" in both values and absentFrom (must be disjoint).`,
			);
		}
	}
}

function validateMapper(
	mapper: PageMapper,
	pageContents: ValidatePageContents,
	result: AssembleResult,
	errors: string[],
): void {
	const page = pageContents.get(mapper.hash);
	if (!page) {
		errors.push(`mapper references unknown page hash "${mapper.hash}".`);
		return;
	}
	for (const e of mapper.entries) {
		validateMapperEntry(mapper.hash, e, page.content, result, errors);
	}
	for (const sp of mapper.demotedSourcePaths) {
		if (readPath(page.content, sp) === undefined) {
			errors.push(
				`mapper demoted sourcePath ${mapper.hash}: "${sp}" does not resolve on page content.`,
			);
		}
	}
}

function validateMapperEntry(
	mapperHash: string,
	entry: PageMapperEntry,
	pageContent: unknown,
	result: AssembleResult,
	errors: string[],
): void {
	if (!pathResolves(result.canonical, entry.canonicalField)) {
		errors.push(
			`mapper entry ${mapperHash}: canonicalField "${entry.canonicalField}" does not resolve on canonical.`,
		);
	}
	if (readPath(pageContent, entry.sourcePath) === undefined) {
		errors.push(
			`mapper entry ${mapperHash}: sourcePath "${entry.sourcePath}" does not resolve on page content.`,
		);
	}
	const slot = result.chromeDynamic[entry.canonicalField];
	if (slot?.absentFrom.includes(mapperHash)) {
		errors.push(
			`mapper entry ${mapperHash}: canonicalField "${entry.canonicalField}" is keep-dynamic but this page is listed as absent in chrome-dynamic.`,
		);
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function placeAtPath(tree: CanonicalTree, path: string, value: unknown): void {
	const parts = splitPath(path);
	if (parts.length === 0) return;
	let cursor: unknown = tree;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const next = parts[i + 1];
		const childIsArray = typeof next === "number";
		cursor = stepIntoOrCreate(cursor, part, childIsArray);
	}
	const last = parts[parts.length - 1];
	if (typeof last === "number") {
		if (!Array.isArray(cursor)) return;
		(cursor as unknown[])[last] = value;
	} else {
		if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor))
			return;
		(cursor as Record<string, unknown>)[last] = value;
	}
}

function stepIntoOrCreate(
	cursor: unknown,
	part: string | number,
	childIsArray: boolean,
): unknown {
	if (typeof part === "number") {
		if (!Array.isArray(cursor)) return cursor;
		const arr = cursor as unknown[];
		if (arr[part] === undefined) {
			arr[part] = childIsArray ? [] : {};
		}
		return arr[part];
	}
	if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
		return cursor;
	}
	const obj = cursor as Record<string, unknown>;
	if (!(part in obj)) {
		obj[part] = childIsArray ? [] : {};
	}
	return obj[part];
}

function pathResolves(tree: CanonicalTree, path: string): boolean {
	return readPath(tree, path) !== undefined;
}

function splitPath(path: string): Array<string | number> {
	const out: Array<string | number> = [];
	if (!path) return out;
	for (const raw of path.split(".")) {
		if (!raw) continue;
		const match = raw.match(/^([^[]*)((?:\[\d+\])*)$/);
		if (!match) {
			out.push(raw);
			continue;
		}
		const [, key, brackets] = match;
		if (key) out.push(key);
		for (const m of brackets.matchAll(/\[(\d+)\]/g)) out.push(Number(m[1]));
	}
	return out;
}
