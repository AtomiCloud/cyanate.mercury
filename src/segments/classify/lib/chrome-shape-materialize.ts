import type { ClassifierPathEntry } from "./chrome-classify.js";
import { setAtPath } from "./chrome-materialize.js";
import { countWildcards, readPath } from "./path-utils.js";

export interface ShapeNormalizedChromeProvenanceEntry {
	sourcePath: string;
	candidatePath: string;
	materializedPath?: string;
	role?: "value" | "identity-key" | "empty-object";
	syntheticIndices?: number[];
}

export interface ShapeNormalizedChromeCollision {
	materializedPath: string;
	firstSourcePath: string;
	secondSourcePath: string;
}

export interface ShapeMaterializeResult {
	chrome: unknown;
	provenance: ShapeNormalizedChromeProvenanceEntry[];
	collisions: ShapeNormalizedChromeCollision[];
}

interface SyntheticIndexState {
	perCollection: Map<string, Map<string, number>>;
}

interface MaterializeContext {
	root: Record<string, unknown> | unknown[];
	provenance: ShapeNormalizedChromeProvenanceEntry[];
	collisions: ShapeNormalizedChromeCollision[];
	seenMaterializedPath: Map<string, string>;
	synthetic: SyntheticIndexState;
}

export function materializeShapeNormalizedChrome(
	chromeContent: unknown,
	chromePaths: readonly ClassifierPathEntry[],
): ShapeMaterializeResult {
	const root: Record<string, unknown> | unknown[] = Array.isArray(chromeContent)
		? []
		: {};
	const provenance: ShapeNormalizedChromeProvenanceEntry[] = [];
	const collisions: ShapeNormalizedChromeCollision[] = [];
	const seenMaterializedPath = new Map<string, string>();
	const synthetic: SyntheticIndexState = {
		perCollection: new Map(),
	};

	preseedSyntheticWildcardIndices(chromeContent, chromePaths, synthetic);

	for (const entry of chromePaths) {
		const value = readPath(chromeContent, entry.sourcePath);
		if (value === undefined) continue;
		materializeShapeEntry(entry, value, {
			root,
			provenance,
			collisions,
			seenMaterializedPath,
			synthetic,
		});
	}

	return { chrome: root, provenance, collisions };
}

function materializeShapeEntry(
	entry: ClassifierPathEntry,
	value: unknown,
	context: MaterializeContext,
): void {
	const candidatePath = entry.suggestedCanonical ?? entry.sourcePath;
	if (entry.materializeAs === "identity-key") {
		recordIdentityKey(context.provenance, entry.sourcePath, candidatePath);
		return;
	}
	if (entry.materializeAs === "empty-object") {
		materializeEmptyObject(entry.sourcePath, candidatePath, context);
		return;
	}
	materializeValue(entry.sourcePath, candidatePath, value, context);
}

function materializeEmptyObject(
	sourcePath: string,
	candidatePath: string,
	context: MaterializeContext,
): void {
	if (
		recordCollisionIfSeen(
			context.collisions,
			context.seenMaterializedPath,
			candidatePath,
			sourcePath,
		)
	) {
		return;
	}
	setAtPath(context.root, candidatePath, {});
	context.provenance.push({
		sourcePath,
		candidatePath,
		materializedPath: candidatePath,
		role: "empty-object",
	});
}

function materializeValue(
	sourcePath: string,
	candidatePath: string,
	value: unknown,
	context: MaterializeContext,
): void {
	const { materializedPath, syntheticIndices } = concretizeCandidatePath(
		sourcePath,
		candidatePath,
		context.synthetic,
	);

	if (
		recordCollisionIfSeen(
			context.collisions,
			context.seenMaterializedPath,
			materializedPath,
			sourcePath,
		)
	) {
		return;
	}
	setAtPath(context.root, materializedPath, value);
	context.provenance.push({
		sourcePath,
		candidatePath,
		materializedPath,
		...(syntheticIndices.length > 0 ? { syntheticIndices } : {}),
	});
}

function recordIdentityKey(
	provenance: ShapeNormalizedChromeProvenanceEntry[],
	sourcePath: string,
	candidatePath: string,
): void {
	provenance.push({
		sourcePath,
		candidatePath,
		role: "identity-key",
	});
}

function recordCollisionIfSeen(
	collisions: ShapeNormalizedChromeCollision[],
	seenMaterializedPath: Map<string, string>,
	materializedPath: string,
	sourcePath: string,
): boolean {
	const firstSourcePath = seenMaterializedPath.get(materializedPath);
	if (!firstSourcePath) {
		seenMaterializedPath.set(materializedPath, sourcePath);
		return false;
	}
	collisions.push({
		materializedPath,
		firstSourcePath,
		secondSourcePath: sourcePath,
	});
	return true;
}

function preseedSyntheticWildcardIndices(
	chromeContent: unknown,
	chromePaths: readonly ClassifierPathEntry[],
	state: SyntheticIndexState,
): void {
	const wildcardEntries = chromePaths
		.filter((entry) => {
			const candidatePath = entry.suggestedCanonical ?? entry.sourcePath;
			return (
				countWildcards(candidatePath) > 0 &&
				readPath(chromeContent, entry.sourcePath) !== undefined
			);
		})
		.sort(compareClassifierPathEntriesBySource);

	for (const entry of wildcardEntries) {
		concretizeCandidatePath(
			entry.sourcePath,
			entry.suggestedCanonical ?? entry.sourcePath,
			state,
		);
	}
}

function compareClassifierPathEntriesBySource(
	a: ClassifierPathEntry,
	b: ClassifierPathEntry,
): number {
	return comparePathSegments(
		parsePathSegments(a.sourcePath),
		parsePathSegments(b.sourcePath),
	);
}

function comparePathSegments(
	a: readonly ShapePathSegment[],
	b: readonly ShapePathSegment[],
): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const cmp = comparePathSegment(a[i], b[i]);
		if (cmp !== 0) return cmp;
	}
	return a.length - b.length;
}

function comparePathSegment(
	a: ShapePathSegment | undefined,
	b: ShapePathSegment | undefined,
): number {
	if (a === b) return 0;
	if (a === undefined) return -1;
	if (b === undefined) return 1;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "number") return -1;
	if (typeof b === "number") return 1;
	return String(a).localeCompare(String(b));
}

function concretizeCandidatePath(
	sourcePath: string,
	candidatePath: string,
	state: SyntheticIndexState,
): { materializedPath: string; syntheticIndices: number[] } {
	const wildcardCount = countWildcards(candidatePath);
	if (wildcardCount === 0) {
		return { materializedPath: candidatePath, syntheticIndices: [] };
	}

	const sourceSegments = parsePathSegments(sourcePath);
	const candidateSegments = parsePathSegments(candidatePath);
	const boundIndices: number[] = [];
	const syntheticIndices: number[] = [];
	const materializedSegments: ShapePathSegment[] = [];
	let bracketOrdinal = -1;

	for (const segment of candidateSegments) {
		if (typeof segment === "number") {
			bracketOrdinal++;
			materializedSegments.push(segment);
			continue;
		}
		if (segment !== "*") {
			materializedSegments.push(segment);
			continue;
		}

		bracketOrdinal++;
		const collectionKey = stringifyPathSegments(
			materializedSegments.concat("*"),
		);
		const sourceItemKey =
			sourceItemKeyAtBracketOrdinal(sourceSegments, bracketOrdinal) ??
			syntheticBaseKey(sourcePath, candidatePath);
		const syntheticIndex = assignSyntheticIndex(
			collectionKey,
			sourceItemKey,
			state,
		);
		boundIndices.push(syntheticIndex);
		syntheticIndices.push(syntheticIndex);
		materializedSegments.push(syntheticIndex);
	}

	let i = 0;
	return {
		materializedPath: candidatePath.replace(
			/\[\*\]/g,
			() => `[${boundIndices[i++]}]`,
		),
		syntheticIndices,
	};
}

function assignSyntheticIndex(
	collectionKey: string,
	sourceItemKey: string,
	state: SyntheticIndexState,
): number {
	let perCollection = state.perCollection.get(collectionKey);
	if (!perCollection) {
		perCollection = new Map();
		state.perCollection.set(collectionKey, perCollection);
	}
	const existing = perCollection.get(sourceItemKey);
	if (existing !== undefined) return existing;
	const nextIndex = perCollection.size;
	perCollection.set(sourceItemKey, nextIndex);
	return nextIndex;
}

type ShapePathSegment = string | number | "*";

function parsePathSegments(path: string): ShapePathSegment[] {
	const out: ShapePathSegment[] = [];
	if (!path) return out;
	for (const raw of path.split(".")) {
		if (!raw) continue;
		const match = raw.match(/^([^[]*)((?:\[(?:\d+|\*)\])*)$/);
		if (!match) {
			out.push(raw);
			continue;
		}
		const [, key, brackets] = match;
		if (key) out.push(key);
		for (const m of brackets.matchAll(/\[(\d+|\*)\]/g)) {
			out.push(m[1] === "*" ? "*" : Number(m[1]));
		}
	}
	return out;
}

function stringifyPathSegments(segments: readonly ShapePathSegment[]): string {
	let out = "";
	for (const segment of segments) {
		if (typeof segment === "number") {
			out += `[${segment}]`;
			continue;
		}
		if (segment === "*") {
			out += "[*]";
			continue;
		}
		out += out ? `.${segment}` : segment;
	}
	return out;
}

function sourceItemKeyAtBracketOrdinal(
	sourceSegments: readonly ShapePathSegment[],
	targetOrdinal: number,
): string | undefined {
	let bracketOrdinal = -1;
	for (let i = 0; i < sourceSegments.length; i++) {
		if (typeof sourceSegments[i] !== "number") continue;
		bracketOrdinal++;
		if (bracketOrdinal === targetOrdinal) {
			return stringifyPathSegments(sourceSegments.slice(0, i + 1));
		}
	}
	return undefined;
}

function syntheticBaseKey(sourcePath: string, candidatePath: string): string {
	const parent = sourcePath.replace(/(\[\d+\])?(\.[^.]+)?$/, "");
	const leaf = sourcePath.split(".").at(-1) ?? sourcePath;
	const candidateLeaf = candidatePath.split(".").at(-1) ?? candidatePath;
	const roleSuffixes = new Set([
		candidateLeaf.replace(/\[\*\]/g, ""),
		"src",
		"alt",
		"href",
		"url",
		"link",
		"label",
		"title",
		"text",
		"placeholder",
		"value",
	]);
	let baseLeaf = leaf;
	for (const suffix of roleSuffixes) {
		if (!suffix) continue;
		const next = trimLeafSuffix(baseLeaf, suffix);
		if (next !== baseLeaf) {
			baseLeaf = next;
			break;
		}
	}
	if (!baseLeaf) return parent;
	return `${parent}|${baseLeaf}`;
}

function trimLeafSuffix(leaf: string, suffix: string): string {
	if (leaf === suffix) return "";
	if (leaf.endsWith(`_${suffix}`)) {
		return leaf.slice(0, -`_${suffix}`.length);
	}
	if (leaf.endsWith(`.${suffix}`)) {
		return leaf.slice(0, -`.${suffix}`.length);
	}
	if (leaf.endsWith(suffix) && leaf.length > suffix.length) {
		return leaf.slice(0, -suffix.length).replace(/[_-]+$/, "");
	}
	return leaf;
}
