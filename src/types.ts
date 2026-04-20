/**
 * Shared type definitions for Mecury.
 */

// --- Scraper output types ---

export interface StructureData {
	site_url?: string;
	scraped_at?: string;
	primary_language?: string;
	total_crawled?: number;
	total_kept?: number;
	page_types: PageType[];
}

interface PageType {
	name: string;
	url_pattern: string;
	description: string;
	sample_urls: string[];
	urls: string[];
}

export interface SchemaData {
	pages: Record<
		string,
		{
			type: string;
			properties: Record<string, unknown>;
			required?: string[];
		}
	>;
	definitions?: Record<string, unknown>;
	$defs?: Record<string, unknown>;
}

export interface ContentData {
	page_types: Record<string, { entries: ContentEntry[] }>;
}

interface ContentEntry {
	url: string;
	content: Record<string, unknown>;
}

/**
 * Internal normalized page content type.
 * Not a direct scraper output — produced by the adapter layer
 * (flattenContent) which injects pagetype from the parent key
 * and synthesizes id.
 */
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

interface ComponentRecipe {
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

interface PageTypeInfo {
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
			paginated?: boolean;
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

interface InteractionPattern {
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
	pageType?: "all" | string | string[];
	route?: string;
	description: string;
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
