/**
 * Shared types for the design segment.
 */

export type { QualityScores } from "../../types.js";

// ---------------------------------------------------------------------------
// Component manifest (from wireframe segment)
// ---------------------------------------------------------------------------

/**
 * Wireframe segment's component-manifest.json shape.
 * Keys are component names (e.g., "HeroSection"), values describe the component
 * with its file path and collection refs.
 */
export interface ComponentManifestOutput {
	components: Record<
		string,
		{
			file: string;
			collections: string[];
		}
	>;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergePlan {
	copies: Array<{
		from: string;
		to: string;
		depId: string;
	}>;
	errors: string[];
}

// ---------------------------------------------------------------------------
// Tokens → CSS
// ---------------------------------------------------------------------------

export type CssPropertyMap = Record<string, string>;

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

export interface ContrastResult {
	ratio: number;
	passesAA: boolean;
	passesAALarge: boolean;
}

export interface ContrastViolation {
	context: string;
	ratio: number;
	required: number;
}

export interface ContrastFix {
	fixed: string;
	adjustment: number;
}

export interface ColorSystem {
	light: CssPropertyMap;
	dark: CssPropertyMap;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface LayerViolation {
	line: number;
	layer: string;
	snippet: string;
}

/** A layer violation with its originating file attached. */
export interface FileViolation {
	file: string;
	line: number;
	layer: string;
	snippet: string;
}

export interface LayerIsolationResult {
	isolated: boolean;
	violations: FileViolation[];
}

export interface LayerIsolationOptions {
	/**
	 * When true, flag top-level sibling @layer blocks that don't belong to
	 * the owned layer. Use this in intermediate phase gates to catch a phase
	 * writing to another phase's layer. Set false for final QA where all
	 * sibling layers are expected (each was written by its own phase).
	 */
	checkSiblingLayers?: boolean;
}

export interface LayerOrderResult {
	valid: boolean;
	actual: string[];
	expected: string[];
}

export interface UnlayeredProperty {
	line: number;
	property: string;
	snippet: string;
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export interface QualityThresholdResult {
	passes: boolean;
	failures: string[];
}

export interface FidelityThresholdResult {
	passes: boolean;
	failures: string[];
}

export interface FinalGateResult {
	passed: boolean;
	errors: string[];
}
