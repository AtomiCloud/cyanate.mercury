/**
 * SonicJS adapter — default CMS implementation.
 *
 * Push: uploads images to R2, creates/updates entries via /api/content endpoints.
 * Pull: fetches entries via /api/collections/{name}/content, writes JSON to src/content/ and src/data/.
 *
 * SonicJS API (verified from installed @sonicjs-cms/core 2.11.0 source):
 * - GET    /api/collections                           — list collections (returns { data: [{id, name}] })
 * - GET    /api/collections/{name}/content            — list entries for a collection (supports limit + offset)
 * - POST   /api/content                               — create entry (body: {collectionId, title, slug, status, data})
 * - PUT    /api/content/{id}                          — update entry
 * - POST   /api/media/upload                          — upload media file (multipart/form-data)
 * - POST   /admin/api/collections                     — create collection shell
 * - GET    /admin/api/collections/{id}                — read collection details + fields
 * - POST   /admin/api/collections/{id}/fields         — create collection field
 *
 * Response format: { data: [...|{...}], meta: {...} }
 * Entry format: { id, title, slug, status, collectionId, data: { ...content fields... }, created_at, updated_at }
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	CmsAdapter,
	CollectionDef,
	FieldDef,
	PullResult,
	PushResult,
	SyncError,
} from "./adapter.js";

async function fetchJson(
	url: string,
	init?: RequestInit & { timeout?: number },
	retries = 2,
): Promise<unknown> {
	const timeout = init?.timeout ?? 30_000;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			const res = await fetch(url, {
				...init,
				signal: controller.signal,
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`${res.status} ${res.statusText}: ${body}`.slice(0, 200),
				);
			}
			return await res.json();
		} catch (err) {
			clearTimeout(timer);
			if (attempt === retries) throw err;
			await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
		}
	}
}

async function getCollectionMap(
	baseUrl: string,
	headers: Record<string, string>,
): Promise<Map<string, string>> {
	const json = (await fetchJson(`${baseUrl}/api/collections`, {
		headers,
	})) as {
		data?: { id?: string; name?: string }[];
	};
	const items = json.data ?? [];
	const map = new Map<string, string>();
	for (const coll of items) {
		if (coll.name && coll.id) {
			map.set(coll.name, coll.id);
		}
	}
	return map;
}

async function fetchAllCollectionEntries(
	baseUrl: string,
	headers: Record<string, string>,
	collectionName: string,
): Promise<{ id?: string; slug?: string; data?: Record<string, unknown> }[]> {
	const items: {
		id?: string;
		slug?: string;
		data?: Record<string, unknown>;
	}[] = [];
	const pageSize = 1000;

	for (let offset = 0; ; offset += pageSize) {
		const url = `${baseUrl}/api/collections/${collectionName}/content?limit=${pageSize}&offset=${offset}`;
		const json = (await fetchJson(url, { headers })) as {
			data?: { id?: string; slug?: string; data?: Record<string, unknown> }[];
		};
		const page = json.data ?? [];
		items.push(...page);
		if (page.length < pageSize) {
			break;
		}
	}

	return items;
}

async function getEntrySlugMap(
	baseUrl: string,
	headers: Record<string, string>,
	collectionName: string,
): Promise<Map<string, string>> {
	const items = await fetchAllCollectionEntries(
		baseUrl,
		headers,
		collectionName,
	);
	const map = new Map<string, string>();
	for (const item of items) {
		if (item.slug && item.id) {
			map.set(item.slug, item.id);
		}
	}
	return map;
}

function rewriteImageFields(
	data: Record<string, unknown>,
	mediaMap: Map<string, string>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(data)) {
		if (value === null || value === undefined) {
			result[key] = value;
		} else if (Array.isArray(value)) {
			result[key] = value.map((item) => {
				if (typeof item === "object" && item !== null) {
					return rewriteImageFields(item as Record<string, unknown>, mediaMap);
				}
				if (typeof item === "string" && mediaMap.has(item)) {
					return mediaMap.get(item);
				}
				return item;
			});
		} else if (typeof value === "object") {
			result[key] = rewriteImageFields(
				value as Record<string, unknown>,
				mediaMap,
			);
		} else if (typeof value === "string" && mediaMap.has(value)) {
			result[key] = mediaMap.get(value);
		} else {
			result[key] = value;
		}
	}

	return result;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	const json = `${JSON.stringify(data, null, 2)}\n`;
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, json, "utf-8");
}

function fieldDefToSchemaProperty(field: FieldDef): Record<string, unknown> {
	const prop: Record<string, unknown> = {
		title: field.name,
		required: field.required,
	};

	switch (field.type) {
		case "string":
			prop.type = field.name === "slug" ? "slug" : "string";
			break;
		case "number":
			prop.type = "number";
			break;
		case "boolean":
			prop.type = "boolean";
			break;
		case "datetime":
			prop.type = "datetime";
			break;
		case "richtext":
			prop.type = "richtext";
			break;
		case "image":
			prop.type = "media";
			break;
		case "select":
			prop.type = "select";
			if (field.options) {
				prop.enum = field.options;
				prop.enumLabels = field.options;
				prop.options = field.options;
			}
			break;
		case "relationship":
			prop.type = "reference";
			if (field.target) {
				prop.collection = field.target;
			}
			break;
		case "repeater": {
			prop.type = "array";
			const itemProperties: Record<string, unknown> = {};
			const itemRequired: string[] = [];
			for (const sub of field.fields ?? []) {
				itemProperties[sub.name] = fieldDefToSchemaProperty(sub);
				if (sub.required) itemRequired.push(sub.name);
			}
			prop.items = {
				type: "object",
				properties: itemProperties,
				...(itemRequired.length > 0 ? { required: itemRequired } : {}),
			};
			break;
		}
		case "object": {
			prop.type = "object";
			const properties: Record<string, unknown> = {};
			const required: string[] = [];
			for (const sub of field.fields ?? []) {
				properties[sub.name] = fieldDefToSchemaProperty(sub);
				if (sub.required) required.push(sub.name);
			}
			prop.properties = properties;
			if (required.length > 0) {
				prop.required = required;
			}
			break;
		}
	}

	return prop;
}

function buildCollectionSchema(fields: FieldDef[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	for (const field of fields) {
		properties[field.name] = fieldDefToSchemaProperty(field);
		if (field.required) required.push(field.name);
	}

	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

function toTitleCase(value: string): string {
	return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeFieldType(field: FieldDef): string {
	switch (field.type) {
		case "string":
			return field.name === "slug" ? "slug" : "string";
		case "richtext":
			return "richtext";
		case "image":
			return "media";
		case "relationship":
			return "reference";
		case "repeater":
			return "array";
		default:
			return field.type;
	}
}

function buildFieldOptions(field: FieldDef): Record<string, unknown> {
	const schemaProp = fieldDefToSchemaProperty(field);
	const options: Record<string, unknown> = { ...schemaProp };
	delete options.title;
	delete options.required;
	return options;
}

async function createCollection(
	baseUrl: string,
	apiKey: string,
	collection: CollectionDef,
): Promise<string> {
	const json = (await fetchJson(`${baseUrl}/admin/api/collections`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			name: collection.name,
			displayName: toTitleCase(collection.name),
			description: `${collection.type} collection: ${collection.name}`,
		}),
		timeout: 30_000,
	})) as { id?: string };

	if (!json.id) {
		throw new Error("Collection creation response missing id");
	}

	return json.id;
}

async function replaceCollectionSchema(
	baseUrl: string,
	apiKey: string,
	collectionId: string,
	collection: CollectionDef,
): Promise<void> {
	const headers = { Authorization: `Bearer ${apiKey}` };
	const details = (await fetchJson(
		`${baseUrl}/admin/api/collections/${collectionId}`,
		{
			headers,
			timeout: 30_000,
		},
	)) as {
		fields?: { id?: string }[];
	};

	for (const field of details.fields ?? []) {
		if (!field.id) continue;
		const res = await fetch(
			`${baseUrl}/admin/collections/${collectionId}/fields/${field.id}`,
			{
				method: "DELETE",
				headers,
			},
		);
		if (!res.ok) {
			throw new Error(
				`Failed to delete existing field: ${res.status} ${res.statusText}`,
			);
		}
	}

	for (const field of collection.fields) {
		const formData = new FormData();
		formData.append("field_name", field.name);
		formData.append("field_label", toTitleCase(field.name));
		formData.append("field_type", normalizeFieldType(field));
		formData.append("is_required", field.required ? "1" : "0");
		formData.append("is_searchable", "0");
		formData.append("field_options", JSON.stringify(buildFieldOptions(field)));

		const res = await fetch(
			`${baseUrl}/admin/collections/${collectionId}/fields`,
			{
				method: "POST",
				headers,
				body: formData,
			},
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(
				`Failed to create field ${field.name}: ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
			);
		}
	}

	const schema = buildCollectionSchema(collection.fields);
	await fetchJson(`${baseUrl}/admin/api/collections/${collectionId}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			display_name: toTitleCase(collection.name),
			description: `${collection.type} collection: ${collection.name}`,
			schema,
		}),
		timeout: 30_000,
	}).catch(() => {
		// Current SonicJS PATCH schema ignores schema updates; field endpoints already mutate it.
	});
}

async function ensureCollectionSchema(
	baseUrl: string,
	apiKey: string,
	collection: CollectionDef,
	existingCollectionId?: string,
): Promise<{ collectionId: string; created: boolean }> {
	const collectionId =
		existingCollectionId ??
		(await createCollection(baseUrl, apiKey, collection));
	await replaceCollectionSchema(baseUrl, apiKey, collectionId, collection);
	return { collectionId, created: !existingCollectionId };
}

export const sonicjs: CmsAdapter = {
	name: "sonicjs",

	async push({
		contentModel,
		collections,
		assetManifest,
		config,
	}): Promise<PushResult> {
		const baseUrl = config.url.replace(/\/$/, "");
		const apiKey = config.apiKey;
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		};

		const errors: SyncError[] = [];
		let schemasCreated = 0;
		let imagesUploaded = 0;
		let entriesPushed = 0;

		console.log("Fetching collection schema...");
		const collectionMap = await getCollectionMap(baseUrl, headers);

		console.log(
			`Ensuring ${contentModel.collections.length} collection schema(s)...`,
		);
		for (const collDef of contentModel.collections) {
			try {
				const existingId = collectionMap.get(collDef.name);
				const result = await ensureCollectionSchema(
					baseUrl,
					apiKey,
					collDef,
					existingId,
				);
				collectionMap.set(collDef.name, result.collectionId);
				if (result.created) {
					schemasCreated++;
					console.log(`  Created collection "${collDef.name}"`);
				} else {
					console.log(`  Updated schema for "${collDef.name}"`);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push({
					collection: collDef.name,
					error: `Schema creation: ${msg}`,
				});
			}
		}

		console.log("Uploading images...");
		const mediaMap = new Map<string, string>();
		const uploadConcurrency = 5;
		const images = assetManifest.entries;

		for (let i = 0; i < images.length; i += uploadConcurrency) {
			const batch = images.slice(i, i + uploadConcurrency);
			await Promise.all(
				batch.map(async (asset) => {
					try {
						const fileData = await readFile(asset.localPath);
						const fileName = asset.localPath.split("/").pop() ?? "file";
						const ext = fileName.split(".").pop()?.toLowerCase();
						const mimeTypes: Record<string, string> = {
							jpg: "image/jpeg",
							jpeg: "image/jpeg",
							png: "image/png",
							gif: "image/gif",
							webp: "image/webp",
							svg: "image/svg+xml",
							pdf: "application/pdf",
							mp4: "video/mp4",
						};
						const mimeType = mimeTypes[ext ?? ""] ?? "application/octet-stream";
						const formData = new FormData();
						formData.append(
							"file",
							new Blob([fileData], { type: mimeType }),
							fileName,
						);

						const res = await fetch(`${baseUrl}/api/media/upload`, {
							method: "POST",
							headers: { Authorization: `Bearer ${apiKey}` },
							body: formData,
						});

						if (!res.ok) {
							throw new Error(`${res.status} ${res.statusText}`);
						}

						const json = (await res.json()) as {
							file?: { publicUrl?: string; r2_key?: string };
							data?: { url?: string; src?: string };
							url?: string;
							src?: string;
						};
						const cmsUrl =
							json.file?.publicUrl ??
							json.data?.url ??
							json.data?.src ??
							json.url ??
							json.src ??
							"";
						mediaMap.set(asset.localPath, cmsUrl);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						errors.push({
							collection: "",
							field: asset.localPath,
							error: `Image upload: ${msg}`,
						});
					}
				}),
			);

			console.log(
				`  Uploaded ${Math.min(i + uploadConcurrency, images.length)}/${images.length}`,
			);
		}

		imagesUploaded = mediaMap.size;

		const totalEntries = collections.reduce((sum, coll) => {
			if (collectionMap.has(coll.name)) return sum + coll.entries.length;
			return sum;
		}, 0);
		console.log(`Pushing entries... (0/${totalEntries})`);

		let processed = 0;
		for (const coll of collections) {
			const collectionId = collectionMap.get(coll.name);
			if (!collectionId) {
				errors.push({
					collection: coll.name,
					error: `Collection "${coll.name}" not found in CMS after schema creation attempt.`,
				});
				continue;
			}

			const existingEntries = await getEntrySlugMap(
				baseUrl,
				headers,
				coll.name,
			);

			for (const entry of coll.entries) {
				processed++;
				try {
					const rewritten = rewriteImageFields(entry.data, mediaMap);
					const collDef = contentModel.collections.find(
						(c) => c.name === coll.name,
					);
					const slugField = collDef?.slugField ?? "slug";
					const slug = (entry.data[slugField] as string) ?? entry.slug;
					const title =
						(rewritten.title as string) ?? (rewritten.name as string) ?? slug;

					const payload = {
						collectionId,
						title,
						slug,
						status: "published",
						data: rewritten,
					};

					const existingId = existingEntries.get(slug);
					if (existingId) {
						await fetchJson(`${baseUrl}/api/content/${existingId}`, {
							method: "PUT",
							headers,
							body: JSON.stringify(payload),
							timeout: 30_000,
						});
					} else {
						await fetchJson(`${baseUrl}/api/content`, {
							method: "POST",
							headers,
							body: JSON.stringify(payload),
							timeout: 30_000,
						});
					}
					entriesPushed++;
					process.stdout.write(
						`\r  Pushing entries... (${processed}/${totalEntries})`,
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					errors.push({
						collection: coll.name,
						slug: entry.slug,
						error: `Push: ${msg}`,
					});
					process.stdout.write(
						`\r  Pushing entries... (${processed}/${totalEntries})`,
					);
				}
			}
		}
		console.log("");

		return { entriesPushed, imagesUploaded, schemasCreated, errors };
	},

	async pull({
		contentModel,
		contentDir,
		dataDir,
		config,
	}): Promise<PullResult> {
		const baseUrl = config.url.replace(/\/$/, "");
		const apiKey = config.apiKey;
		const headers = {
			Authorization: `Bearer ${apiKey}`,
		};

		const errors: SyncError[] = [];
		let entriesPulled = 0;
		const filesWritten: string[] = [];

		console.log("Pulling collections...");
		await Promise.all(
			contentModel.collections.map(async (coll) => {
				try {
					console.log(`  Pulling collection "${coll.name}"...`);
					const items = await fetchAllCollectionEntries(
						baseUrl,
						headers,
						coll.name,
					);

					for (const item of items) {
						try {
							const slug = item.slug ?? item.id;
							if (!slug) continue;

							let outputPath: string;
							if (coll.type === "singleton") {
								outputPath = join(dataDir, `${coll.name}.json`);
							} else if (coll.type === "global") {
								outputPath = join(dataDir, "globals", `${coll.name}.json`);
							} else {
								outputPath = join(contentDir, coll.name, `${slug}.json`);
							}

							const entryData: Record<string, unknown> =
								coll.type === "collection"
									? { slug, ...(item.data ?? {}) }
									: { ...(item.data ?? {}) };

							await writeJsonFile(outputPath, entryData);
							filesWritten.push(outputPath);
							entriesPulled++;
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							errors.push({
								collection: coll.name,
								error: `Write file: ${msg}`,
							});
						}
					}

					console.log(`    → ${items.length} entries fetched`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					errors.push({
						collection: coll.name,
						error: `Fetch: ${msg}`,
					});
				}
			}),
		);

		return { entriesPulled, filesWritten, errors };
	},
};
