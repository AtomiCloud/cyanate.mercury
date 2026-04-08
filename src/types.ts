/**
 * Shared type definitions for Mecury.
 */

// --- Scraper output types ---

export interface ScraperOutput {
	structure: StructureData;
	schema: SchemaData;
	content: ContentData;
}

export interface StructureData {
	site_url?: string;
	pages: PageStructure[];
}

export interface PageStructure {
	id: string;
	url: string;
	pagetype: string;
	title: string;
	references?: string[];
}

export interface SchemaData {
	[pageType: string]: {
		type: string;
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ContentData {
	pages: PageContent[];
}

export interface PageContent {
	id: string;
	url: string;
	pagetype: string;
	content: Record<string, unknown>;
}

// --- Phase 0: Style Fingerprint ---

export interface StyleFingerprint {
	$schema: string;
	style: {
		primary: string;
		secondary: string[];
		dimensions: {
			ornament: number;
			playfulness: number;
			warmth: number;
			density: number;
			motion: number;
			depth: number;
			darkness: number;
			formality: number;
		};
		treatments: {
			surface: string;
			corners: string;
			shadows: string;
			borders: string;
			gradients: string;
			blur: boolean;
			transparency: boolean;
			animation_style: string;
		};
	};
	confidence: number;
}

// --- Phase 0: 7-Layer Design Tokens ---

export interface DesignTokensV2 {
	atomic: {
		colors: Record<string, string>;
		typography: {
			fontFamily: Record<string, string>;
			fontSize: Record<string, string>;
			fontWeight: Record<string, number>;
		};
		spacing: Record<string, string>;
		borderRadius: Record<string, string>;
		shadows: Record<string, string>;
	};
	gradients: Record<string, GradientDef>;
	layout: {
		grid: {
			columns: Record<string, string>;
			gutter: Record<string, string>;
		};
		container: {
			maxWidth: Record<string, string>;
		};
		breakpoints: Record<string, string>;
		sections: Record<string, { top: string; bottom: string }>;
		density: { mode: string };
		rhythm: {
			baseUnit: string;
			verticalRhythm: Record<string, string>;
		};
	};
	componentSpacing: Record<string, Record<string, string>>;
	motion: {
		duration: Record<string, string>;
		easing: Record<string, string>;
		state: {
			hover: Record<string, unknown>;
			focus: Record<string, unknown>;
			active: Record<string, unknown>;
			disabled: Record<string, unknown>;
		};
		scroll: Record<string, unknown>;
		skeleton: Record<string, unknown>;
	};
	surfaces: {
		glass: Record<string, Record<string, unknown>>;
		texture: Record<string, Record<string, unknown>>;
		imageTreatment: Record<string, Record<string, unknown>>;
	};
	visualIdentity: {
		colorDistribution: {
			dominant: Record<string, unknown>;
			secondary: Record<string, unknown>;
			accent: Record<string, unknown>;
		};
		borders: Record<string, Record<string, unknown>>;
	};
}

export interface GradientDef {
	type: string;
	angle?: string;
	stops: Array<{ color: string; position?: string }>;
}

// --- Phase 0: Component Recipes ---

export interface ComponentRecipes {
	[componentName: string]: ComponentRecipe;
}

export interface ComponentRecipe {
	base: Record<string, unknown>;
	variants: Record<string, Record<string, unknown>>;
	states?: Record<string, Record<string, unknown>>;
}

// --- Phase 1: Structure types ---

export interface ReducedMeta {
	source: {
		total_pages: number;
		page_types: number;
		scraped_at: string;
		site_url: string;
	};
	global_keys: string[];
	page_types: PageTypeInfo[];
	pagination_candidates: Array<{
		pagetype: string;
		evidence: string;
	}>;
}

export interface PageTypeInfo {
	pagetype: string;
	route: string;
	count: number;
	multi: boolean;
	has_pagination: boolean;
	slug_param?: string;
	schema_keys: string[];
	own_keys: string[];
}

export interface Registry {
	layouts: Record<
		string,
		{
			description: string;
			page_types: string[];
		}
	>;
	collections: Record<
		string,
		{
			source_pagetype: string;
			slug_field: string;
			listable_by: string[];
			filterable_by?: string | string[] | Array<Record<string, unknown>>;
			search_fields?: string[];
			slug_pattern?: string;
			slug_extract?: number | string;
			ordered?: boolean;
		}
	>;
	listings: Record<
		string,
		{
			route: string;
			queries: Array<{
				collection?: string;
				group_by?: string;
				filter_by_param?: string;
				filter?: string;
				[key: string]: unknown;
			}>;
			paginated: boolean;
			searchable?: boolean;
			search_fields?: string[];
		}
	>;
	static_pages: Array<{
		pagetype: string;
		route: string;
		layout?: string;
	}>;
	navigation?: Record<string, unknown>;
	interactive_patterns?: InteractionPattern[];
}

export interface InteractionPattern {
	id: string;
	type:
		| "fragment"
		| "modal"
		| "accordion"
		| "tabs"
		| "search"
		| "filter"
		| "form"
		| "popup"
		| "other";
	trigger?: string;
	target?: string;
	pageType?: string;
	route?: string;
	description: string;
}

export interface InteractionManifest {
	patterns: InteractionPattern[];
	pages: Array<{
		route: string;
		ids: string[];
		triggers: string[];
	}>;
}

// --- Phase 6: Quality ---

export interface QualityScores {
	overall: number;
	dimensions: {
		layoutConsistency: number;
		designTokenUsage: number;
		componentComposition: number;
		responsiveDesign: number;
		semanticHtml: number;
		visualAppeal: number;
		motionQuality: number;
	};
}

export interface TestReport {
	timestamp: string;
	pages: Array<{
		url: string;
		loadOk: boolean;
		consoleErrors: string[];
		brokenLinks: string[];
	}>;
	responsive: {
		mobile375: { passed: boolean; issues: string[] };
		tablet768: { passed: boolean; issues: string[] };
		desktop1280: { passed: boolean; issues: string[] };
	};
	functional: {
		linksChecked: number;
		brokenLinks: string[];
		buttonsChecked: number;
		brokenButtons: string[];
	};
}

// --- Config types ---

/**
 * @deprecated Use CuiConfig from engine/types.ts instead.
 * This type is kept for backwards compatibility with archived v1 code.
 */
export interface CuiConfig {
	/** Path to scraper output directory */
	input: string;
	/** Reference website URL for design extraction */
	reference?: string;
	/** Default env profile name (e.g., "claude" -> .env.claude) */
	profile: string;
	/** Env profile for reviewer agents. Falls back to `profile` if not set. */
	reviewerProfile?: string;
	/** Model ID for vision-capable reviewers. */
	visionModel?: string;
	/** Per-step overrides keyed by step ID */
	steps?: Record<string, StepConfigOverride>;
}

export interface StepConfigOverride {
	profile?: string;
	env?: Record<string, string>;
	skip?: boolean;
	maxConcurrentPageAgents?: number;
}

// --- Run metadata ---

export interface RunMetadata {
	runId: string;
	status: "running" | "completed" | "failed";
	config: CuiConfig;
	inputPath: string;
	referenceUrl?: string;
	profileName: string;
	runDir: string;
	createdAt: string;
	finishedAt?: string;
	completedSteps: string[];
	failedStep?: string;
	resumedFrom?: string;
}

// --- Phase gate validation ---

export interface PhaseGateResult {
	passed: boolean;
	errors: string[];
	warnings?: string[];
}
