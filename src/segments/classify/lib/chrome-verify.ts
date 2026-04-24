/**
 * Pure logic for Stage 4 — deterministic chrome round-trip verifier.
 *
 * For every page in a page-type, confirm:
 *   1. No duplicate sourcePaths in the per-page mapper.
 *   2. Every mapper entry's sourcePath resolves on the original page content.
 *   3. Every mapper entry's canonicalField resolves on the page-type canonical.
 *   4. The value at sourcePath (on content) equals the canonical/dynamic value.
 *      Static slots compare against canonical. Dynamic slots (canonical leaf
 *      is the "<dynamic>" sentinel) compare against the per-page entry in the
 *      chromeDynamic sidecar, keyed by pageHash.
 *
 * Coverage follows from Stage 3's post-pass: every Stage 2 chromePath for a
 * page was routed to either mapper.entries or mapper.demotedSourcePaths. Stage
 * 4 doesn't re-check that surjection; it checks that the mapper entries still
 * describe valid chrome.
 *
 * This module is pure — no IO.
 */

import { splitByChromePaths } from "./chrome-split.js";
import { stableValueHash } from "./harmonize-occurrence.js";
import {
	CHROME_DYNAMIC_SENTINEL,
	type ChromeDynamic,
	type PageMapper,
} from "./harmonize-types.js";
import { readPath } from "./path-utils.js";

export interface VerifyPageInput {
	hash: string;
	content: unknown;
	mapper: PageMapper;
	canonical: unknown;
	chromeDynamic: ChromeDynamic;
}

export interface VerifyPageResult {
	hash: string;
	status: "pass" | "fail";
	body: unknown;
	chromeEntryCount: number;
	demotedCount: number;
	errors: string[];
}

function checkEntryStructure(
	input: VerifyPageInput,
	errors: string[],
): Set<string> {
	const seen = new Set<string>();
	for (const entry of input.mapper.entries) {
		if (seen.has(entry.sourcePath)) {
			errors.push(`duplicate sourcePath in mapper: "${entry.sourcePath}"`);
		}
		seen.add(entry.sourcePath);
	}
	for (const demoted of input.mapper.demotedSourcePaths) {
		if (seen.has(demoted)) {
			errors.push(
				`sourcePath "${demoted}" appears in both mapper.entries and mapper.demotedSourcePaths (must be disjoint)`,
			);
		}
	}
	return seen;
}

function checkEntryValue(
	input: VerifyPageInput,
	entry: { sourcePath: string; canonicalField: string },
	errors: string[],
): void {
	const pageValue = readPath(input.content, entry.sourcePath);
	if (pageValue === undefined) {
		errors.push(
			`sourcePath "${entry.sourcePath}" does not resolve on page content`,
		);
		return;
	}
	const canonicalValue = readPath(input.canonical, entry.canonicalField);
	if (canonicalValue === undefined) {
		errors.push(
			`canonicalField "${entry.canonicalField}" does not resolve on canonical`,
		);
		return;
	}
	if (canonicalValue === CHROME_DYNAMIC_SENTINEL) {
		checkDynamicEntryValue(input, entry, pageValue, errors);
		return;
	}
	if (stableValueHash(pageValue) !== stableValueHash(canonicalValue)) {
		errors.push(
			`value mismatch at sourcePath "${entry.sourcePath}" vs canonicalField "${entry.canonicalField}"`,
		);
	}
}

function checkDynamicEntryValue(
	input: VerifyPageInput,
	entry: { sourcePath: string; canonicalField: string },
	pageValue: unknown,
	errors: string[],
): void {
	const slot = input.chromeDynamic[entry.canonicalField];
	if (!slot) {
		errors.push(
			`canonicalField "${entry.canonicalField}" is keep-dynamic but chrome-dynamic has no slot for it`,
		);
		return;
	}
	if (slot.absentFrom.includes(input.hash)) {
		errors.push(
			`canonicalField "${entry.canonicalField}" lists page "${input.hash}" as absent but the mapper routes a sourcePath to it`,
		);
		return;
	}
	const entryForPage = slot.values.find((e) => e.pageHash === input.hash);
	if (!entryForPage) {
		errors.push(
			`chrome-dynamic slot "${entry.canonicalField}" has no value for page "${input.hash}"`,
		);
		return;
	}
	if (stableValueHash(pageValue) !== stableValueHash(entryForPage.value)) {
		errors.push(
			`dynamic value mismatch at sourcePath "${entry.sourcePath}" vs chrome-dynamic slot "${entry.canonicalField}" for page "${input.hash}"`,
		);
	}
}

export function verifyOnePage(input: VerifyPageInput): VerifyPageResult {
	const errors: string[] = [];

	checkEntryStructure(input, errors);
	for (const entry of input.mapper.entries) {
		checkEntryValue(input, entry, errors);
	}
	for (const demoted of input.mapper.demotedSourcePaths) {
		if (readPath(input.content, demoted) === undefined) {
			errors.push(
				`demoted sourcePath "${demoted}" does not resolve on page content`,
			);
		}
	}

	const sourcePaths = input.mapper.entries.map((e) => e.sourcePath);
	const { body } = splitByChromePaths(input.content, sourcePaths);

	return {
		hash: input.hash,
		status: errors.length === 0 ? "pass" : "fail",
		body,
		chromeEntryCount: input.mapper.entries.length,
		demotedCount: input.mapper.demotedSourcePaths.length,
		errors,
	};
}

export interface VerifyPageTypeInput {
	pagetype: string;
	canonical: unknown;
	chromeDynamic: ChromeDynamic;
	pages: Array<{ hash: string; content: unknown; mapper: PageMapper }>;
}

export interface VerifyPageTypeResult {
	pagetype: string;
	status: "pass" | "fail";
	perPage: VerifyPageResult[];
	passCount: number;
	failCount: number;
}

export function verifyPageType(
	input: VerifyPageTypeInput,
): VerifyPageTypeResult {
	const perPage = input.pages.map((p) =>
		verifyOnePage({
			hash: p.hash,
			content: p.content,
			mapper: p.mapper,
			canonical: input.canonical,
			chromeDynamic: input.chromeDynamic,
		}),
	);
	const passCount = perPage.filter((r) => r.status === "pass").length;
	const failCount = perPage.length - passCount;
	return {
		pagetype: input.pagetype,
		status: failCount === 0 ? "pass" : "fail",
		perPage,
		passCount,
		failCount,
	};
}
