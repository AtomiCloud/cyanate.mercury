/**
 * Pure split logic for Stage 2 — partition a page's content into chrome + body.
 *
 * Given the original `content` tree and the accepted `chromePaths` from the
 * classifier, produce two trees:
 *   - `chrome`: only leaves whose dot-path is in `chromePaths`.
 *   - `body`:   every other leaf.
 *
 * Arrays are compacted on both sides — if some elements contribute to chrome
 * and others to body, both sides drop the empty items rather than keeping
 * sparse / null-padded arrays. This keeps the split files readable for humans;
 * cross-page alignment is Stage 3's job (harmonize).
 *
 * The split is total and disjoint by construction: every leaf in the input
 * ends up in exactly one of {chrome, body}.
 */

import { isLeaf } from "./path-utils.js";

export interface SplitOutput {
	chrome: unknown;
	body: unknown;
}

export function splitByChromePaths(
	content: unknown,
	chromePaths: readonly string[],
): SplitOutput {
	const chromeSet = new Set(chromePaths);
	const [chrome, body] = splitNode(content, "", chromeSet);
	return {
		chrome: chrome ?? emptyLike(content),
		body: body ?? emptyLike(content),
	};
}

type Node = unknown | undefined;

function splitNode(
	value: unknown,
	path: string,
	chromeSet: Set<string>,
): [Node, Node] {
	if (isLeaf(value)) {
		return chromeSet.has(path) ? [value, undefined] : [undefined, value];
	}
	if (Array.isArray(value)) return splitArray(value, path, chromeSet);
	if (typeof value === "object" && value !== null) {
		return splitObject(value as Record<string, unknown>, path, chromeSet);
	}
	return [undefined, value];
}

function splitArray(
	value: readonly unknown[],
	path: string,
	chromeSet: Set<string>,
): [Node, Node] {
	const chromeArr: unknown[] = [];
	const bodyArr: unknown[] = [];
	for (let i = 0; i < value.length; i++) {
		const [c, b] = splitNode(value[i], `${path}[${i}]`, chromeSet);
		if (c !== undefined) chromeArr.push(c);
		if (b !== undefined) bodyArr.push(b);
	}
	return [
		chromeArr.length > 0 ? chromeArr : undefined,
		bodyArr.length > 0 ? bodyArr : undefined,
	];
}

function splitObject(
	obj: Record<string, unknown>,
	path: string,
	chromeSet: Set<string>,
): [Node, Node] {
	const chromeObj: Record<string, unknown> = {};
	const bodyObj: Record<string, unknown> = {};
	let hasChrome = false;
	let hasBody = false;
	for (const [k, v] of Object.entries(obj)) {
		const childPath = path ? `${path}.${k}` : k;
		const [c, b] = splitNode(v, childPath, chromeSet);
		if (c !== undefined) {
			chromeObj[k] = c;
			hasChrome = true;
		}
		if (b !== undefined) {
			bodyObj[k] = b;
			hasBody = true;
		}
	}
	return [hasChrome ? chromeObj : undefined, hasBody ? bodyObj : undefined];
}

function emptyLike(value: unknown): unknown {
	if (Array.isArray(value)) return [];
	return {};
}
