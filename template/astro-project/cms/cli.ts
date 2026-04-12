/**
 * CMS CLI — entry point for cms push/pull commands.
 *
 * Usage:
 *   bun run cms push    — push content to CMS
 *   bun run cms pull    — pull content from CMS
 *
 * Config:
 *   cms.config.json — adapter name, URL, API key (gitignored)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AssetManifest,
	CmsAdapter,
	CollectionData,
	ContentModel,
	EntryData,
} from "./adapter.js";

// ---- Adapter registry ----

const adapters: Record<string, () => Promise<CmsAdapter>> = {
	sonicjs: () => import("./sonicjs.js").then((m) => m.sonicjs),
	// directus: () => import("./directus.js").then((m) => m.directus),
};

// ---- Config ----

interface CmsConfig {
	adapter: string;
	url: string;
	apiKey: string;
	tenantId?: string;
}

async function loadConfig(): Promise<CmsConfig> {
	const configPath = join(cwd(), "cms.config.json");
	try {
		const raw = await readFile(configPath, "utf-8");
		return JSON.parse(raw) as CmsConfig;
	} catch {
		console.error("Error: cms.config.json not found. Create it with:");
		console.error('  { "adapter": "sonicjs", "url": "...", "apiKey": "...", "tenantId": "..." }');
		process.exit(1);
	}
}

async function loadJson<T>(filePath: string): Promise<T> {
	const raw = await readFile(filePath, "utf-8");
	return JSON.parse(raw) as T;
}

// ---- Content discovery ----

/**
 * Recursively walk a directory and return all JSON files.
 */
async function walkJson(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");

	try {
		const matches: string[] = [];

		async function walk(currentDir: string): Promise<void> {
			const entries = await readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(currentDir, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath);
				} else if (entry.name.endsWith(".json")) {
					matches.push(fullPath);
				}
			}
		}

		await walk(dir);
		return matches;
	} catch {
		return [];
	}
}

/**
 * Load all entries from src/content/{collection}/ and src/data/.
 */
async function loadCollections(
	contentDir: string,
	dataDir: string,
): Promise<CollectionData[]> {
	const collections: CollectionData[] = [];

	// Load regular collections from src/content/
	const contentJsonFiles = await walkJson(contentDir);

	// Group by collection name (parent directory)
	const byCollection = new Map<string, string[]>();
	for (const file of contentJsonFiles) {
		const rel = file.slice(contentDir.length + 1);
		const parts = rel.split("/");
		if (parts.length >= 2) {
			const collName = parts[0];
			if (!byCollection.has(collName)) byCollection.set(collName, []);
			byCollection.get(collName)?.push(file);
		}
	}

	for (const [collName, files] of byCollection) {
		const entries: EntryData[] = [];
		for (const file of files) {
			const slug = basename(file, ".json");
			const raw = await readFile(file, "utf-8");
			entries.push({ slug, data: JSON.parse(raw) });
		}
		collections.push({ name: collName, type: "collection", entries });
	}

	// Load singletons and globals from src/data/
	try {
		const dataFiles = await walkJson(dataDir);
		for (const file of dataFiles) {
			const rel = file.slice(dataDir.length + 1);
			const parts = rel.split("/");
			const fileName = parts[parts.length - 1];
			const name = basename(fileName, ".json");

			// Skip globals subdirectory for now — handled below
			if (parts.length === 1) {
				// Singleton at src/data/{name}.json
				const raw = await readFile(file, "utf-8");
				collections.push({
					name,
					type: "singleton",
					entries: [{ slug: name, data: JSON.parse(raw) }],
				});
			}
		}

		// Load globals from src/data/globals/
		const globalsDir = join(dataDir, "globals");
		try {
			const globalFiles = await walkJson(globalsDir);
			for (const file of globalFiles) {
				const name = basename(file, ".json");
				const raw = await readFile(file, "utf-8");
				collections.push({
					name,
					type: "global",
					entries: [{ slug: name, data: JSON.parse(raw) }],
				});
			}
		} catch {
			// No globals directory — ok
		}
	} catch {
		// No data directory — ok
	}

	return collections;
}

// ---- Commands ----

async function cmdPush(
	adapter: CmsAdapter,
	config: Record<string, string>,
): Promise<void> {
	console.log("CMS Push — content files → CMS\n");

	// Project root is cwd() — where package.json lives
	const rootDir = cwd();

	const contentModel = await loadJson<ContentModel>(
		join(rootDir, "content-model.json"),
	);
	const assetManifest = await loadJson<AssetManifest>(
		join(rootDir, "asset-manifest.json"),
	);

	const srcDir = join(rootDir, "src");
	const contentDir = join(srcDir, "content");
	const dataDir = join(srcDir, "data");

	const collections = await loadCollections(contentDir, dataDir);

	console.log(`Pushing ${collections.length} collections...`);
	const result = await adapter.push({
		contentModel,
		collections,
		assetManifest,
		config,
	});

	// Print summary
	console.log("\nPush complete:");
	console.log(
		`  Pushed ${result.entriesPushed} entries, ${result.imagesUploaded} images, ${result.schemasCreated} schemas`,
	);

	if (result.errors.length > 0) {
		console.error(`\n${result.errors.length} error(s):`);
		for (const err of result.errors) {
			const ctx = [err.collection, err.slug, err.field]
				.filter(Boolean)
				.join("/");
			console.error(`  [${ctx || "?"}] ${err.error}`);
		}
		process.exit(1);
	}
}

async function cmdPull(
	adapter: CmsAdapter,
	config: Record<string, string>,
): Promise<void> {
	console.log("CMS Pull — CMS → content files\n");

	// Project root is cwd() — where package.json lives
	const rootDir = cwd();

	const contentModel = await loadJson<ContentModel>(
		join(rootDir, "content-model.json"),
	);

	const srcDir = join(rootDir, "src");
	const contentDir = join(srcDir, "content");
	const dataDir = join(srcDir, "data");

	const result = await adapter.pull({
		contentModel,
		contentDir,
		dataDir,
		config,
	});

	// Print summary
	console.log("\nPull complete:");
	console.log(
		`  Pulled ${result.entriesPulled} entries, wrote ${result.filesWritten.length} files`,
	);

	if (result.errors.length > 0) {
		console.error(`\n${result.errors.length} error(s):`);
		for (const err of result.errors) {
			const ctx = [err.collection, err.slug, err.field]
				.filter(Boolean)
				.join("/");
			console.error(`  [${ctx || "?"}] ${err.error}`);
		}
		process.exit(1);
	}
}

// ---- Main ----

function cwd(): string {
	return process.cwd();
}

function basename(path: string, ext?: string): string {
	const name = path.split("/").pop() ?? path;
	if (ext && name.endsWith(ext)) {
		return name.slice(0, -ext.length);
	}
	return name;
}

async function main(): Promise<void> {
	const [, , command] = process.argv;

	if (!command || command === "help") {
		console.log("Usage: bun run cms <command>");
		console.log("Commands:");
		console.log("  push  — push content files to CMS");
		console.log("  pull  — pull content from CMS");
		console.log("");
		console.log("Config: cms.config.json (gitignored)");
		process.exit(command ? 0 : 1);
	}

	if (command !== "push" && command !== "pull") {
		console.error(`Unknown command: ${command}`);
		console.error("Valid commands: push, pull");
		process.exit(1);
	}

	const cfg = await loadConfig();

	const loader = adapters[cfg.adapter];
	if (!loader) {
		console.error(`Unknown adapter: ${cfg.adapter}`);
		console.error(`Available: ${Object.keys(adapters).join(", ")}`);
		process.exit(1);
	}

	const adapter = await loader();

	if (command === "push") {
		await cmdPush(adapter, { url: cfg.url, apiKey: cfg.apiKey, ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}) });
	} else {
		await cmdPull(adapter, { url: cfg.url, apiKey: cfg.apiKey, ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}) });
	}
}

main().catch((err) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`Fatal: ${msg}`);
	process.exit(1);
});
