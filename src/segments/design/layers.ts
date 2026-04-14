/**
 * Pure: CSS layer isolation checking and layer file generation.
 *
 * Verifies that each phase's output only modifies its owned @layer block,
 * preventing cross-layer contamination that would break phase independence.
 */

import type {
	FileViolation,
	LayerIsolationOptions,
	LayerIsolationResult,
	LayerOrderResult,
	LayerViolation,
	UnlayeredProperty,
} from "./types.js";

// ---------------------------------------------------------------------------
// Layer order validation
// ---------------------------------------------------------------------------

/**
 * Verify @layer declaration order in layers.css.
 *
 * Returns { valid, actual, expected }.
 */
export function validateLayerOrder(
	layersContent: string,
	expectedOrder: string[],
): LayerOrderResult {
	// Find all @layer declarations in order
	const declarationRegex = /@layer\s+([\w\s,]+)/g;
	const actual: string[] = [];

	for (const match of layersContent.matchAll(declarationRegex)) {
		// @layer can declare multiple comma-separated names
		const names = match[1]?.split(",").map((n) => n.trim()) ?? [];
		actual.push(...names);
	}

	return {
		valid: actual.join(", ") === expectedOrder.join(", "),
		actual,
		expected: expectedOrder,
	};
}

// ---------------------------------------------------------------------------
// Layer violation detection
// ---------------------------------------------------------------------------

/**
 * Parse @layer blocks from CSS content, returning { layer, start, end, body }.
 */
interface ParsedLayer {
	layer: string;
	start: number;
	end: number;
	body: string;
}

function parseLayerBlocks(content: string): ParsedLayer[] {
	const blocks: ParsedLayer[] = [];

	// Match @layer name { ... }
	// Handle nested braces correctly
	const layerRegex = /@layer\s+([\w-]+)\s*\{/g;

	let searchStart = 0;
	while (true) {
		layerRegex.lastIndex = searchStart;
		const openMatch = layerRegex.exec(content);
		if (!openMatch) break;

		const layerName = openMatch[1];
		const openBrace = openMatch.index + openMatch[0].length;
		let depth = 1;
		let pos = openBrace;

		while (depth > 0 && pos < content.length) {
			if (content[pos] === "{") depth++;
			else if (content[pos] === "}") depth--;
			pos++;
		}

		const body = content.slice(openBrace, pos - 1);
		blocks.push({
			layer: layerName,
			start: openMatch.index,
			end: pos,
			body,
		});

		searchStart = pos;
	}

	return blocks;
}

/**
 * Find all lines in CSS content that belong to a specific @layer.
 */
function linesInLayer(body: string, ownedLayer: string): Set<number> {
	// We're inside the owned layer's body — all content there is fine
	// Violations are lines that reference OTHER layers
	const lines = new Set<number>();
	const lineNumbers = body.split("\n");

	for (let i = 0; i < lineNumbers.length; i++) {
		const line = lineNumbers[i].trim();
		// Check if this line references a different layer
		const layerRefMatch = line.match(/@layer\s+([\w-]+)/);
		if (layerRefMatch && layerRefMatch[1] !== ownedLayer) {
			lines.add(i + 1); // 1-indexed
		}
	}

	return lines;
}

/**
 * Detect nested @layer references inside the owned layer body.
 */
function findNestedLayerViolations(
	cssContent: string,
	blocks: ParsedLayer[],
	ownedLayer: string,
	lines: string[],
): LayerViolation[] {
	const owned = blocks.find((b) => b.layer === ownedLayer);
	if (!owned) return [];

	// Find the character position where the owned layer's body starts
	// (right after the opening brace of "@layer name {")
	const layerDecl = cssContent.slice(owned.start);
	const bracePos = layerDecl.indexOf("{");
	const bodyStartChar = owned.start + bracePos + 1;

	const violations: LayerViolation[] = [];
	const violationLines = linesInLayer(owned.body, ownedLayer);
	for (const lineNo of violationLines) {
		const globalLine = findGlobalLineNumber(cssContent, lineNo, bodyStartChar);
		if (globalLine >= 0) {
			const line = lines[globalLine - 1].trim();
			const layerRefMatch = line.match(/@layer\s+([\w-]+)/);
			violations.push({
				line: globalLine,
				layer: layerRefMatch ? layerRefMatch[1] : "unknown",
				snippet: line,
			});
		}
	}
	return violations;
}

/**
 * Find layer violations within a CSS file.
 *
 * Always detects nested foreign layers: @layer Y inside @layer X (Y ≠ X).
 *
 * When checkSiblingLayers is true, also flags top-level sibling @layer blocks
 * that belong to a different layer. This catches a phase writing to another
 * phase's layer block at the top level.
 */
export function findLayerViolations(
	cssContent: string,
	ownedLayer: string,
	allLayers: string[],
	checkSiblingLayers = false,
): LayerViolation[] {
	const blocks = parseLayerBlocks(cssContent);
	const lines = cssContent.split("\n");

	const violations = [
		...findNestedLayerViolations(cssContent, blocks, ownedLayer, lines),
	];

	if (checkSiblingLayers) {
		const layerSet = new Set(allLayers);
		for (const block of blocks) {
			if (block.layer !== ownedLayer && layerSet.has(block.layer)) {
				const startLine = cssContent.slice(0, block.start).split("\n").length;
				violations.push({
					line: startLine,
					layer: block.layer,
					snippet: lines[startLine - 1]?.trim() ?? "",
				});
			}
		}
	}

	return violations;
}

/**
 * Find the global (1-indexed) line number in content that corresponds to
 * a line number within a @layer body, given the character offset where
 * the body starts.
 */
function findGlobalLineNumber(
	cssContent: string,
	layerBodyLine: number,
	bodyStartChar: number,
): number {
	const before = cssContent.slice(0, bodyStartChar);
	const bodyStartLine = before.split("\n").length; // 1-indexed
	const globalLine = bodyStartLine + layerBodyLine - 1; // layerBodyLine is 1-indexed within body
	const totalLines = cssContent.split("\n").length;
	return globalLine <= totalLines ? globalLine : -1;
}

// ---------------------------------------------------------------------------
// Layer isolation check
// ---------------------------------------------------------------------------

/**
 * Extract all <style> blocks from an Astro file's raw content.
 * Returns the concatenated text content of all <style> tags.
 */
function extractAstroStyleBlocks(astroContent: string): string {
	const styleBlocks: string[] = [];
	// Match <style>...</style> with optional lang/module attributes.
	// Handle both <style> and <style ...> variants.
	const styleRegex = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;
	for (const match of astroContent.matchAll(styleRegex)) {
		styleBlocks.push(match[1]);
	}
	return styleBlocks.join("\n");
}

/**
 * Check a single .astro file for layer violations in its <style> blocks.
 */
function checkAstroFileIsolation(
	file: string,
	content: string,
	ownedLayer: string,
	allLayers: string[],
	options?: LayerIsolationOptions,
): FileViolation[] {
	const styleContent = extractAstroStyleBlocks(content);
	if (!styleContent) return [];

	return findLayerViolations(
		styleContent,
		ownedLayer,
		allLayers,
		options?.checkSiblingLayers,
	).map((v): FileViolation => ({ file, ...v }));
}

/**
 * Check a single .css file for layer violations and unlayered properties.
 * Custom properties in :root/.dark are allowed (filtered by buildExcludedRanges).
 */
function checkCssFileIsolation(
	file: string,
	content: string,
	ownedLayer: string,
	allLayers: string[],
	options?: LayerIsolationOptions,
): FileViolation[] {
	const violations: FileViolation[] = [];

	// Check @layer violations
	for (const v of findLayerViolations(
		content,
		ownedLayer,
		allLayers,
		options?.checkSiblingLayers,
	)) {
		violations.push({ file, ...v });
	}

	// Flag unlayered properties (plain CSS outside any @layer block)
	for (const u of findUnlayeredProperties(content)) {
		violations.push({
			file,
			line: u.line,
			layer: "unlayered",
			snippet: u.snippet,
		});
	}

	return violations;
}

/**
 * Check that a set of files only write within their owned @layer.
 *
 * Returns { isolated, violations } where violations include file, line,
 * layer, and snippet for each cross-layer write.
 *
 * .astro files: <style> blocks are extracted and checked for layer violations.
 * .css files: layer violations are checked AND unlayered properties are flagged.
 */
export function checkLayerIsolation(
	fileContents: Record<string, string>,
	ownedLayer: string,
	allLayers: string[],
	options?: LayerIsolationOptions,
): LayerIsolationResult {
	const violations: LayerIsolationResult["violations"] = [];

	for (const [file, content] of Object.entries(fileContents)) {
		if (file.endsWith(".astro")) {
			violations.push(
				...checkAstroFileIsolation(
					file,
					content,
					ownedLayer,
					allLayers,
					options,
				),
			);
		} else if (file.endsWith(".css")) {
			violations.push(
				...checkCssFileIsolation(file, content, ownedLayer, allLayers, options),
			);
		}
		// .ts and .tsx files are skipped (they may import CSS but don't own styles)
	}

	return {
		isolated: violations.length === 0,
		violations,
	};
}

// ---------------------------------------------------------------------------
// Unlayered properties
// ---------------------------------------------------------------------------

/**
 * Find CSS properties declared outside any @layer block.
 *
 * These are global styles that could cause conflicts.
 * Allowed: CSS custom properties in :root, @keyframes, @media
 */
export function findUnlayeredProperties(
	cssContent: string,
): UnlayeredProperty[] {
	// Build excluded ranges from @layer blocks and special at-rules
	const excludedRanges = buildExcludedRanges(cssContent);
	const lines = cssContent.split("\n");
	const unlayered: UnlayeredProperty[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const lineNumber = i + 1;

		if (isExcludedLine(trimmed)) continue;

		if (isWithinExcludedRange(cssContent, lineNumber, excludedRanges)) continue;

		const prop = extractPropertyDeclaration(trimmed);
		if (prop) {
			unlayered.push({ line: lineNumber, property: prop, snippet: trimmed });
		}
	}

	return unlayered;
}

/**
 * Build ranges of content that are excluded from unlayered property checks.
 */
function buildExcludedRanges(cssContent: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	// Parse @layer blocks
	for (const block of parseLayerBlocks(cssContent)) {
		ranges.push([block.start, block.end]);
	}

	// Parse :root blocks (both :root { } and :root(selector) { })
	for (const match of cssContent.matchAll(/:root\s*(?:\([^)]*\))?\s*\{/g)) {
		if (match.index !== undefined) {
			const end = findBlockEnd(cssContent, match.index + match[0].length);
			ranges.push([match.index, end]);
		}
	}

	// Parse .dark blocks (D4: .dark { --var: ... } is allowed outside layers)
	for (const match of cssContent.matchAll(/\.dark\s*\{/g)) {
		if (match.index !== undefined) {
			const end = findBlockEnd(cssContent, match.index + match[0].length);
			ranges.push([match.index, end]);
		}
	}

	// @import statements end with semicolon, not braces
	for (const match of cssContent.matchAll(/^@import\s+["'][^"']+["']\s*;/gm)) {
		ranges.push([match.index, match.index + match[0].length]);
	}

	// @charset statements end with semicolon
	for (const match of cssContent.matchAll(/^@charset\s+["'][^"']+["']\s*;/gm)) {
		ranges.push([match.index, match.index + match[0].length]);
	}

	const specialRulesWithBraces = [
		/^@keyframes\s+[\w-]+\s*\{/m,
		/^@media\s+/m,
		/^@supports\s+/m,
		/^@font-face\s*\{/m,
	];

	for (const rule of specialRulesWithBraces) {
		for (const match of cssContent.matchAll(new RegExp(rule.source, "g"))) {
			if (match.index !== undefined) {
				const end = findBlockEnd(cssContent, match.index + match[0].length);
				ranges.push([match.index, end]);
			}
		}
	}

	return ranges;
}

/**
 * Find the end of a CSS block given the position after the opening brace.
 */
function findBlockEnd(content: string, start: number): number {
	let depth = 1;
	let pos = start;

	while (depth > 0 && pos < content.length) {
		if (content[pos] === "{") depth++;
		else if (content[pos] === "}") depth--;
		pos++;
	}

	return pos;
}

/**
 * Check if a line should be excluded from property checking.
 */
function isExcludedLine(line: string): boolean {
	if (line === "") return true;
	if (line.startsWith("/*") || line.startsWith("//")) return true;
	if (line.startsWith(":root")) return true;
	if (line.startsWith(".dark")) return true;
	if (line.startsWith("[")) return true;
	if (line.startsWith("@")) return true;
	return false;
}

/**
 * Extract a CSS property name from a line, or null if not a property declaration.
 */
function extractPropertyDeclaration(line: string): string | null {
	const propMatch = line.match(/^([\w-]+)\s*:/);
	return propMatch ? propMatch[1] : null;
}

/**
 * Check if a given line number falls within an excluded range.
 * Ranges are [startCharPos, endCharPos) — half-open intervals.
 */
function isWithinExcludedRange(
	content: string,
	lineNumber: number,
	ranges: Array<[number, number]>,
): boolean {
	// Convert 1-indexed line number to character position
	const lines = content.split("\n");
	if (lineNumber < 1 || lineNumber > lines.length) {
		return false;
	}

	// Compute starting character position of the target line
	let charPos = 0;
	for (let i = 0; i < lineNumber - 1; i++) {
		charPos += lines[i].length + 1; // +1 for newline
	}

	// Check if this position falls within any excluded range
	for (const [start, end] of ranges) {
		if (charPos >= start && charPos < end) {
			return true;
		}
	}
	return false;
}
