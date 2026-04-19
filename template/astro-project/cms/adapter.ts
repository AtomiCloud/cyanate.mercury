/**
 * CMS Adapter — abstract interface between Astro content collections and headless CMS.
 *
 * This file defines the contract. Implementations (sonicjs.ts, directus.ts, etc.)
 * live in sibling files and are loaded by cli.ts.
 *
 * NO CMS-specific types here — it's the pure abstract boundary.
 */

// ---- Field types ----

export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "datetime"
	| "richtext"
	| "image"
	| "select"
	| "relationship"
	| "repeater"
	| "object";

export interface FieldDef {
	name: string;
	type: FieldType;
	required: boolean;
	options?: string[]; // for select
	target?: string; // for relationship — target collection name
	fields?: FieldDef[]; // for repeater/object — nested fields
}

export interface CollectionDef {
	name: string;
	type: "collection" | "singleton" | "global" | "shared";
	fields: FieldDef[];
	slugField?: string; // which field is the slug (default: 'slug')
}

export interface ContentModel {
	collections: CollectionDef[];
}

// ---- Data types ----

export interface EntryData {
	slug: string;
	data: Record<string, unknown>;
}

export interface CollectionData {
	name: string;
	type: "collection" | "singleton" | "global" | "shared";
	entries: EntryData[];
}

export interface AssetManifest {
	entries: { localPath: string; originalUrl: string }[];
}

// ---- Result types ----

export interface SyncError {
	collection: string;
	slug?: string;
	field?: string;
	error: string;
}

export interface PushResult {
	entriesPushed: number;
	imagesUploaded: number;
	schemasCreated: number;
	errors: SyncError[];
}

export interface PullResult {
	entriesPulled: number;
	filesWritten: string[];
	errors: SyncError[];
}

// ---- Adapter interface ----

export interface CmsAdapter {
	name: string;

	/**
	 * Push: Astro content files -> CMS
	 *
	 * Used for initial seed after pipeline generates content.
	 * Creates CMS schemas/collections, uploads images, creates entries.
	 */
	push(opts: {
		contentModel: ContentModel;
		collections: CollectionData[];
		assetManifest: AssetManifest;
		config: Record<string, string>;
	}): Promise<PushResult>;

	/**
	 * Pull: CMS -> Astro content files
	 *
	 * Used for ongoing sync when content editors update the CMS.
	 * Fetches all entries, transforms to Astro format, writes JSON files.
	 */
	pull(opts: {
		contentModel: ContentModel;
		contentDir: string; // absolute path to src/content/
		config: Record<string, string>;
	}): Promise<PullResult>;
}
