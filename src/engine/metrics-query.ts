/**
 * Metrics query engine — PromQL-esque mini-language for pipeline metrics.
 *
 * Grammar:
 *   query   = AGG_FN "by" "(" labels ")" filter?
 *   filter  = "{" matcher ("," matcher)* "}"
 *   matcher = label "=" quoted_string
 *   AGG_FN  = avg | sum | max | min | count | p50 | p90 | p99
 *
 * All numeric columns (turns, inputTokens, outputTokens, cost, duration)
 * are aggregated and shown automatically.
 */

import {
	STEP_VALUE_KEYS,
	type StepMetric,
	type StepValueKey,
} from "./metrics.js";

// ---------------------------------------------------------------------------
// Parser types
// ---------------------------------------------------------------------------

const AGG_FUNCTIONS = [
	"avg",
	"sum",
	"max",
	"min",
	"count",
	"p50",
	"p90",
	"p99",
] as const;
type AggFn = (typeof AGG_FUNCTIONS)[number];

interface ParsedQuery {
	fn: AggFn;
	groupBy: string[];
	filters: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseQuery(input: string): ParsedQuery {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Empty query. Example: avg by (segment, phase)");
	}

	const fn = parseAggFn(trimmed);
	const afterFn = trimmed.slice(trimmed.indexOf("(") + 1);

	const closeParen = afterFn.indexOf(")");
	if (closeParen === -1) {
		throw new Error('Missing closing ")" for group-by labels');
	}

	const groupBy = parseLabels(afterFn.slice(0, closeParen));
	const remainder = afterFn.slice(closeParen + 1).trim();
	const filters = parseFilters(remainder);

	return { fn, groupBy, filters };
}

function parseAggFn(query: string): AggFn {
	const fnMatch = /^(\w+)\s+by\s*\(/i.exec(query);
	if (!fnMatch) {
		throw new Error(
			`Expected "AGG_FN by (labels)". Got: "${query.slice(0, 40)}"`,
		);
	}
	const fn = fnMatch[1].toLowerCase();
	if (!AGG_FUNCTIONS.includes(fn as AggFn)) {
		throw new Error(
			`Unknown aggregation "${fn}". Available: ${AGG_FUNCTIONS.join(", ")}`,
		);
	}
	return fn as AggFn;
}

function parseLabels(labelStr: string): string[] {
	const labels = labelStr
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (labels.length === 0) {
		throw new Error("At least one group-by label is required");
	}
	return labels;
}

function parseFilters(remainder: string): Record<string, string> {
	const filters: Record<string, string> = {};
	if (!remainder.startsWith("{")) return filters;

	const closeBrace = remainder.indexOf("}");
	if (closeBrace === -1) {
		throw new Error('Missing closing "}" for filter');
	}
	const filterStr = remainder.slice(1, closeBrace);
	for (const part of filterStr.split(",")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		let val = part.slice(eq + 1).trim();
		if (isQuoted(val)) val = val.slice(1, -1);
		if (key) filters[key] = val;
	}
	return filters;
}

function isQuoted(s: string): boolean {
	return (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type ResultRow = Record<string, string | number>;

export function executeQuery(
	records: StepMetric[],
	query: ParsedQuery,
): ResultRow[] {
	// Apply filters
	const filtered = records.filter((r) => {
		for (const [key, val] of Object.entries(query.filters)) {
			const recVal = String(
				(r as unknown as Record<string, unknown>)[key] ?? "",
			);
			if (recVal !== val) return false;
		}
		return true;
	});

	// Group by labels
	const groups = new Map<string, StepMetric[]>();
	for (const r of filtered) {
		const key = query.groupBy
			.map((l) => String((r as unknown as Record<string, unknown>)[l] ?? ""))
			.join("\0");
		const list = groups.get(key);
		if (list) list.push(r);
		else groups.set(key, [r]);
	}

	// Aggregate each group
	const rows: ResultRow[] = [];
	for (const [key, items] of groups) {
		const row: ResultRow = {};

		// Label columns
		const keyParts = key.split("\0");
		for (let i = 0; i < query.groupBy.length; i++) {
			row[query.groupBy[i]] = keyParts[i];
		}

		// Count column (always useful)
		row.count = items.length;

		// Aggregate each numeric value column
		for (const vk of STEP_VALUE_KEYS) {
			row[vk] = aggregate(
				query.fn,
				items.map((r) => r[vk]),
			);
		}

		rows.push(row);
	}

	// Sort by cost descending (most expensive first)
	rows.sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));

	return rows;
}

function aggregate(fn: AggFn, values: number[]): number {
	if (values.length === 0) return 0;

	switch (fn) {
		case "sum":
			return values.reduce((a, b) => a + b, 0);
		case "avg":
			return values.reduce((a, b) => a + b, 0) / values.length;
		case "max":
			return Math.max(...values);
		case "min":
			return Math.min(...values);
		case "count":
			return values.length;
		case "p50":
			return percentile(values, 0.5);
		case "p90":
			return percentile(values, 0.9);
		case "p99":
			return percentile(values, 0.99);
	}
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.ceil(sorted.length * p) - 1;
	return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

export function formatTable(rows: ResultRow[]): string {
	if (rows.length === 0) return "(no results)";

	const keys = Object.keys(rows[0]);
	const formatted: string[][] = [];

	// Format each cell
	for (const row of rows) {
		const cells: string[] = [];
		for (const k of keys) {
			cells.push(formatCell(k, row[k]));
		}
		formatted.push(cells);
	}

	// Compute column widths
	const widths = keys.map((k, i) =>
		Math.max(k.length, ...formatted.map((r) => r[i].length)),
	);

	// Build output
	const lines: string[] = [];

	// Header
	lines.push(keys.map((k, i) => k.padEnd(widths[i])).join("  "));
	lines.push(widths.map((w) => "─".repeat(w)).join("──"));

	// Rows
	for (const cells of formatted) {
		lines.push(
			cells
				.map((c, i) => {
					// Right-align numeric columns
					const isNumeric =
						STEP_VALUE_KEYS.includes(keys[i] as StepValueKey) ||
						keys[i] === "count";
					return isNumeric ? c.padStart(widths[i]) : c.padEnd(widths[i]);
				})
				.join("  "),
		);
	}

	return lines.join("\n");
}

function formatCell(key: string, value: string | number): string {
	if (typeof value === "string") return value;

	if (key === "cost") {
		return value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`;
	}
	if (key === "duration") {
		return formatDuration(value);
	}
	if (key === "inputTokens" || key === "outputTokens") {
		return formatTokens(value);
	}
	// turns, count, iteration, retry
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(2);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = Math.floor(secs / 60);
	const rem = Math.round(secs % 60);
	return `${mins}m${String(rem).padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(Math.round(n));
}
