/**
 * Robust JSON extraction from AI agent text output.
 *
 * Replaces greedy regex (`/\{[\s\S]*\}/`) which captures from the first
 * opening bracket to the LAST closing bracket — spanning across non-JSON
 * text if the AI wraps output in explanation.
 *
 * Algorithm: scan for each opening bracket, track nesting depth to find
 * the matching close, try JSON.parse. Return the first valid parse.
 */

/**
 * Extract the first valid JSON object from text.
 * Returns the parsed value, or null if none found.
 */
export function extractJsonObject(text: string): unknown | null {
	return extractJson(text, "{", "}");
}

/**
 * Extract the first valid JSON array from text.
 * Returns the parsed value, or null if none found.
 */
export function extractJsonArray(text: string): unknown[] | null {
	return extractJson(text, "[", "]") as unknown[] | null;
}

function extractJson(
	text: string,
	open: string,
	close: string,
): unknown | null {
	let pos = 0;
	while (pos < text.length) {
		const start = text.indexOf(open, pos);
		if (start === -1) break;

		// Skip brackets inside string literals in surrounding text
		const end = findMatchingClose(text, start, open, close);
		if (end === -1) {
			pos = start + 1;
			continue;
		}

		const candidate = text.slice(start, end + 1);
		try {
			return JSON.parse(candidate);
		} catch {
			// Not valid JSON at this position — try next opening bracket
			pos = start + 1;
		}
	}
	return null;
}

/** Skip past a JSON string literal starting at the opening quote. Returns index of closing quote, or -1. */
function skipString(text: string, start: number): number {
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") {
			i++; // skip escaped char
		} else if (text[i] === '"') {
			return i;
		}
	}
	return -1;
}

/**
 * Find the matching closing bracket respecting nesting depth.
 * Skips brackets inside JSON string literals.
 */
function findMatchingClose(
	text: string,
	start: number,
	open: string,
	close: string,
): number {
	let depth = 0;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];

		if (ch === '"') {
			const end = skipString(text, i);
			if (end === -1) return -1;
			i = end;
			continue;
		}

		if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
	}

	return -1;
}
