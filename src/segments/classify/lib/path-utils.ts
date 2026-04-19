/**
 * Dot-path utilities for nested JSON-like values.
 *
 * Paths use `.key` for object keys and `[N]` for array indices
 * (e.g. `items[0].title`). A leaf path terminates at a primitive, null,
 * undefined, or an empty container.
 *
 * (Renamed from `coverage.ts` — these are pure path/tree utilities, not
 * coverage-specific. The new coverage/partition logic lives in `block-ops.ts`.)
 */

type PathToken = string | number;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectArrayPaths(arr: unknown[], base: string): string[] {
	if (arr.length === 0) return base === "" ? [] : [base];
	const out: string[] = [];
	for (let i = 0; i < arr.length; i++) {
		out.push(...collectAllLeafPaths(arr[i], `${base}[${i}]`));
	}
	return out;
}

function collectObjectPaths(
	obj: Record<string, unknown>,
	base: string,
): string[] {
	const keys = Object.keys(obj);
	if (keys.length === 0) return base === "" ? [] : [base];
	const out: string[] = [];
	for (const k of keys) {
		const seg = base === "" ? k : `${base}.${k}`;
		out.push(...collectAllLeafPaths(obj[k], seg));
	}
	return out;
}

/**
 * Walk a nested value and return dot-paths to every leaf reachable from the
 * root. Empty objects and empty arrays are treated as leaves so round-trip
 * checks can detect their presence.
 */
export function collectAllLeafPaths(value: unknown, base = ""): string[] {
	if (value === null || value === undefined) {
		return base === "" ? [] : [base];
	}
	if (Array.isArray(value)) return collectArrayPaths(value, base);
	if (isPlainObject(value)) return collectObjectPaths(value, base);
	return [base];
}

function parsePath(path: string): PathToken[] | null {
	const tokens: PathToken[] = [];
	let i = 0;
	while (i < path.length) {
		if (path[i] === "[") {
			const end = path.indexOf("]", i);
			if (end < 0) return null;
			tokens.push(Number(path.slice(i + 1, end)));
			i = end + 1;
			if (path[i] === ".") i++;
			continue;
		}
		let end = i;
		while (end < path.length && path[end] !== "." && path[end] !== "[") {
			end++;
		}
		tokens.push(path.slice(i, end));
		i = end;
		if (path[i] === ".") i++;
	}
	return tokens;
}

function stepToken(cur: unknown, token: PathToken): unknown {
	if (cur === null || cur === undefined) return undefined;
	if (typeof token === "number") {
		return Array.isArray(cur) ? cur[token] : undefined;
	}
	return isPlainObject(cur) ? cur[token] : undefined;
}

/**
 * Read a value from a nested object/array by dot-path. Returns `undefined`
 * if any segment is unreachable.
 */
export function readPath(value: unknown, path: string): unknown {
	if (path === "") return value;
	const tokens = parsePath(path);
	if (tokens === null) return undefined;
	let cur: unknown = value;
	for (const t of tokens) cur = stepToken(cur, t);
	return cur;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!deepEqual(a[i], b[i])) return false;
	}
	return true;
}

function objectsEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const k of aKeys) {
		if (!Object.hasOwn(b, k)) return false;
		if (!deepEqual(a[k], b[k])) return false;
	}
	return true;
}

/** Structural equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b || typeof a !== "object") return false;
	if (Array.isArray(a)) {
		return Array.isArray(b) && arraysEqual(a, b);
	}
	if (Array.isArray(b)) return false;
	return objectsEqual(
		a as Record<string, unknown>,
		b as Record<string, unknown>,
	);
}
