/**
 * Deterministic pre-pass for A0 normalization.
 *
 * Walks every leaf in a page's content and resolves the obvious cases in
 * code — typeof-match, strict ISO, pure-number strings, yes/no/true/false,
 * simple currency, empty containers. Anything ambiguous (natural-language
 * dates, comma-joined phrases that might be arrays or might be place names,
 * currency-ish without a symbol) is handed back as a list of leaves for the
 * LLM batch pass.
 *
 * Rules are conservative: when in doubt, prefer ambiguous over wrong. A
 * wrong deterministic call silently corrupts downstream output; an
 * ambiguous one is just an extra LLM call.
 */

import { collectAllLeafPaths, readPath } from "./lib/path-utils.js";
import type { NormalizationEntry, NormType } from "./per-page-classify.js";

export interface AmbiguousLeaf {
	path: string;
	original: unknown;
}

export interface DeterministicResult {
	resolved: Record<string, NormalizationEntry>;
	ambiguous: AmbiguousLeaf[];
}

const ISO_8601 =
	/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const PURE_NUMBER = /^-?\d+(\.\d+)?$/;
const BOOLEAN_LITERAL = /^(true|false|yes|no)$/i;
const CURRENCY = /^[$£€¥]\s*\d[\d,]*(\.\d+)?$/;

const DATE_WORDS =
	/(ago|yesterday|tomorrow|today|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)/i;

function classifyPrimitive(v: unknown): NormalizationEntry | null {
	if (v === null || v === undefined) {
		return { original: v, normalized: v, type: "null" };
	}
	if (typeof v === "number" && Number.isFinite(v)) {
		return { original: v, normalized: v, type: "number" };
	}
	if (typeof v === "boolean") {
		return { original: v, normalized: v, type: "boolean" };
	}
	return null;
}

function classifyEmptyContainer(v: unknown): NormalizationEntry | null {
	if (Array.isArray(v) && v.length === 0) {
		return { original: v, normalized: v, type: "array" };
	}
	if (
		v !== null &&
		typeof v === "object" &&
		!Array.isArray(v) &&
		Object.keys(v as Record<string, unknown>).length === 0
	) {
		return { original: v, normalized: v, type: "object" };
	}
	return null;
}

function hasComma(s: string): boolean {
	return s.includes(",");
}

function isDateIsh(s: string): boolean {
	return DATE_WORDS.test(s);
}

function classifyStringTautological(s: string): NormalizationEntry | null {
	if (ISO_8601.test(s)) {
		return { original: s, normalized: s, type: "datetime" };
	}
	if (PURE_NUMBER.test(s)) {
		return { original: s, normalized: Number.parseFloat(s), type: "number" };
	}
	if (BOOLEAN_LITERAL.test(s)) {
		const lower = s.toLowerCase();
		const normalized = lower === "true" || lower === "yes";
		return { original: s, normalized, type: "boolean" };
	}
	const cur = CURRENCY.exec(s);
	if (cur) {
		const n = Number.parseFloat(s.replace(/[^\d.-]/g, ""));
		if (Number.isFinite(n)) {
			return { original: s, normalized: n, type: "currency" };
		}
	}
	if (s.trim() === "") {
		return { original: s, normalized: s, type: "string" };
	}
	return null;
}

function shouldBailToAmbiguous(s: string): boolean {
	if (hasComma(s)) return true;
	if (isDateIsh(s)) return true;
	return false;
}

function classifyLeaf(v: unknown): NormalizationEntry | "ambiguous" {
	const prim = classifyPrimitive(v);
	if (prim) return prim;
	const empty = classifyEmptyContainer(v);
	if (empty) return empty;

	if (typeof v === "string") {
		const taut = classifyStringTautological(v);
		if (taut) return taut;
		if (shouldBailToAmbiguous(v)) return "ambiguous";
		return { original: v, normalized: v, type: "unchanged" };
	}

	return "ambiguous";
}

/**
 * Walk every leaf path in `content` and classify it deterministically where
 * possible. Leaves that can't be resolved with high confidence are returned
 * as `ambiguous` for an LLM pass.
 */
export function deterministicNormalize(
	content: Record<string, unknown>,
): DeterministicResult {
	const paths = collectAllLeafPaths(content);
	const resolved: Record<string, NormalizationEntry> = {};
	const ambiguous: AmbiguousLeaf[] = [];

	for (const path of paths) {
		const value = readPath(content, path);
		const result = classifyLeaf(value);
		if (result === "ambiguous") {
			ambiguous.push({ path, original: value });
		} else {
			resolved[path] = result;
		}
	}

	return { resolved, ambiguous };
}

/**
 * Exposed for unit tests — keep in sync with classifyLeaf.
 * @public
 */
export const __test = {
	classifyLeaf,
	classifyStringTautological,
	shouldBailToAmbiguous,
} as const;

export type { NormType };
