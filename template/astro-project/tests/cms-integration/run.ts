/**
 * CMS Integration Test Runner
 *
 * Tests the full push/pull cycle against a local SonicJS instance.
 * Creates an isolated temp project directory to avoid mutating real source files.
 *
 * Run with: bun run test:cms
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Config ----

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(TEST_DIR, "fixtures");
const SONICJS_DIR = join(TEST_DIR, "sonicjs-app");
const TMP_DIR = join(TEST_DIR, "tmp");

/**
 * The astro project root — where cms/ and package.json live.
 * We resolve it relative to the test dir.
 */
const PROJECT_ROOT = dirname(dirname(TEST_DIR));

// ---- Content model image field extraction ----

/**
 * Extract all image field names from the content model, including nested ones.
 * Returns a set of field names like: { "portrait", "heroImage", "ogImage", "image" }
 */
function extractImageFieldNames(
	collections: Array<{
		fields: Array<{
			name: string;
			type: string;
			fields?: Array<{ name: string; type: string; fields?: unknown[] }>;
		}>;
	}>,
): Set<string> {
	const names = new Set<string>();

	function walkFields(
		fields: Array<{
			name: string;
			type: string;
			fields?: Array<{ name: string; type: string; fields?: unknown[] }>;
		}>,
	): void {
		for (const field of fields) {
			if (field.type === "image") {
				names.add(field.name);
			}
			if (field.fields) {
				walkFields(
					field.fields as Array<{
						name: string;
						type: string;
						fields?: Array<{ name: string; type: string; fields?: unknown[] }>;
					}>,
				);
			}
		}
	}

	for (const coll of collections) {
		walkFields(coll.fields);
	}
	return names;
}

// ---- Helpers ----

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrl(
	url: string,
	maxAttempts = 30,
	interval = 1000,
): Promise<boolean> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const res = await fetch(url, { method: "HEAD" });
			if (res.ok) return true;
		} catch {
			// Not ready yet
		}
		await sleep(interval);
	}
	return false;
}

function runCommand(
	cmd: string,
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			cwd: options?.cwd,
			env: { ...process.env, ...options?.env },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => (stdout += d.toString()));
		proc.stderr?.on("data", (d) => (stderr += d.toString()));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}

async function loadJson(filePath: string): Promise<unknown> {
	const raw = await readFile(filePath, "utf-8");
	return JSON.parse(raw);
}

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<void> {
	const { readdir, copyFile } = await import("node:fs/promises");
	await mkdir(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDir(srcPath, destPath);
		} else {
			await copyFile(srcPath, destPath);
		}
	}
}

/**
 * Recursively copy a directory, applying a content rewrite function to each file.
 * Only applies to `.json` files.
 */
async function copyDirRewrite(
	src: string,
	dest: string,
	rewrite: (content: string) => Promise<string>,
): Promise<void> {
	const { readdir, copyFile, readFile } = await import("node:fs/promises");
	await mkdir(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDirRewrite(srcPath, destPath, rewrite);
		} else if (entry.name.endsWith(".json")) {
			const raw = await readFile(srcPath, "utf-8");
			const rewritten = await rewrite(raw);
			await writeFile(destPath, rewritten, "utf-8");
		} else {
			await copyFile(srcPath, destPath);
		}
	}
}

/**
 * Recursively compare two JSON objects, ignoring image URL fields.
 * Uses content-model metadata to identify image fields by name.
 */
function deepEqualWithUrlTolerance(
	a: unknown,
	b: unknown,
	imageFields: Set<string>,
	path = "",
): { equal: boolean; path: string; aVal: unknown; bVal: unknown } | null {
	if (a === b) return null;

	if (typeof a !== typeof b) {
		return { equal: false, path, aVal: a, bVal: b };
	}

	if (a === null || b === null) {
		if (a !== b) return { equal: false, path, aVal: a, bVal: b };
		return null;
	}

	if (
		typeof a === "string" ||
		typeof a === "number" ||
		typeof a === "boolean"
	) {
		if (a !== b) return { equal: false, path, aVal: a, bVal: b };
		return null;
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) {
			return { equal: false, path, aVal: a.length, bVal: b.length };
		}
		for (let i = 0; i < a.length; i++) {
			const result = deepEqualWithUrlTolerance(
				a[i],
				b[i],
				imageFields,
				`${path}[${i}]`,
			);
			if (result) return result;
		}
		return null;
	}

	if (typeof a === "object" && typeof b === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

		for (const key of allKeys) {
			const valPath = path ? `${path}.${key}` : key;
			if (!(key in aObj))
				return {
					equal: false,
					path: valPath,
					aVal: undefined,
					bVal: bObj[key],
				};
			if (!(key in bObj))
				return {
					equal: false,
					path: valPath,
					aVal: aObj[key],
					bVal: undefined,
				};

			// Image fields — use content-model metadata to identify image fields
			if (imageFields.has(key)) {
				// Just check both are non-empty strings (URLs)
				if (
					typeof aObj[key] === "string" &&
					typeof bObj[key] === "string" &&
					(aObj[key] as string).length > 0 &&
					(bObj[key] as string).length > 0
				) {
					continue;
				}
			}

			const result = deepEqualWithUrlTolerance(
				aObj[key],
				bObj[key],
				imageFields,
				valPath,
			);
			if (result) return result;
		}
		return null;
	}

	return { equal: false, path, aVal: a, bVal: b };
}

/**
 * Recursively compare two directory trees byte-for-byte.
 * Returns null if identical, or a description of the first mismatch.
 */
async function compareDirectoryTrees(
	dirA: string,
	dirB: string,
): Promise<string | null> {
	const { readdir } = await import("node:fs/promises");
	if (!existsSync(dirA) && !existsSync(dirB)) return null;
	if (!existsSync(dirA)) return `${dirA} does not exist`;
	if (!existsSync(dirB)) return `${dirB} does not exist`;

	const entriesA = await readdir(dirA, { withFileTypes: true });
	const entriesB = await readdir(dirB, { withFileTypes: true });

	const namesA = new Set(entriesA.map((e) => e.name));
	const namesB = new Set(entriesB.map((e) => e.name));

	for (const name of namesA) {
		if (!namesB.has(name))
			return `File ${name} exists in first but not second pull`;
	}
	for (const name of namesB) {
		if (!namesA.has(name))
			return `File ${name} exists in second but not first pull`;
	}

	for (const entry of entriesA) {
		const pathA = join(dirA, entry.name);
		const pathB = join(dirB, entry.name);
		if (entry.isDirectory()) {
			const subResult = await compareDirectoryTrees(pathA, pathB);
			if (subResult) return subResult;
		} else {
			const contentA = await readFile(pathA, "utf-8");
			const contentB = await readFile(pathB, "utf-8");
			if (contentA !== contentB) {
				return `File ${entry.name} differs (first: ${contentA.length} bytes, second: ${contentB.length} bytes)`;
			}
		}
	}
	return null;
}

// ---- Temp project setup ----

/**
 * Create an isolated temp project directory with all files the CLI needs.
 * This avoids mutating the real project's src/ directory.
 */
/**
 * Rewrite image paths in JSON data to use the temp project's images/ directory.
 * The fixture data references "tests/cms-integration/fixtures/images/" but the
 * temp project stores images at "images/".
 */
async function rewriteImagePathsInJson(content: string): Promise<string> {
	const OLD_PREFIX = "tests/cms-integration/fixtures/images/";
	const NEW_PREFIX = "images/";
	if (content.includes(OLD_PREFIX)) {
		return content.replaceAll(OLD_PREFIX, NEW_PREFIX);
	}
	return content;
}

async function createTempProject(): Promise<string> {
	const projectDir = join(TMP_DIR, "project");

	// Clean if exists
	if (existsSync(projectDir)) {
		await runCommand("rm", ["-rf", projectDir]);
	}
	await mkdir(projectDir, { recursive: true });

	// Copy cms/ directory (adapter code)
	await copyDir(join(PROJECT_ROOT, "cms"), join(projectDir, "cms"));

	// Copy content-model.json from fixtures
	const contentModelSrc = join(FIXTURES_DIR, "content-model.json");
	const contentModelRaw = await readFile(contentModelSrc, "utf-8");
	await writeFile(
		join(projectDir, "content-model.json"),
		contentModelRaw,
		"utf-8",
	);

	// Copy images/ to tempProject/images/ and update asset-manifest.json
	// to use "images/" paths instead of "tests/cms-integration/fixtures/images/"
	await copyDir(join(FIXTURES_DIR, "images"), join(projectDir, "images"));

	const assetManifestSrc = join(FIXTURES_DIR, "asset-manifest.json");
	const assetManifestRaw = await readFile(assetManifestSrc, "utf-8");
	const assetManifestUpdated = await rewriteImagePathsInJson(assetManifestRaw);
	await writeFile(
		join(projectDir, "asset-manifest.json"),
		assetManifestUpdated,
		"utf-8",
	);

	// Copy fixture src/content/ and src/data/ into temp project,
	// rewriting image paths to use "images/" instead of the long fixture path
	await copyDirRewrite(
		join(FIXTURES_DIR, "src", "content"),
		join(projectDir, "src", "content"),
		rewriteImagePathsInJson,
	);
	await copyDirRewrite(
		join(FIXTURES_DIR, "src", "data"),
		join(projectDir, "src", "data"),
		rewriteImagePathsInJson,
	);

	// Write cms.config.json
	await writeFile(
		join(projectDir, "cms.config.json"),
		JSON.stringify(
			{
				adapter: "sonicjs",
				url: "http://localhost:8787",
				apiKey: "test-api-key",
			},
			null,
			2,
		),
		"utf-8",
	);

	// Copy package.json (needed for tsx to resolve cms imports)
	const pkgRaw = await readFile(join(PROJECT_ROOT, "package.json"), "utf-8");
	await writeFile(join(projectDir, "package.json"), pkgRaw, "utf-8");

	// Copy tsconfig.json if it exists (for tsx type resolution)
	const tsconfigPath = join(PROJECT_ROOT, "tsconfig.json");
	if (existsSync(tsconfigPath)) {
		const tsconfigRaw = await readFile(tsconfigPath, "utf-8");
		await writeFile(join(projectDir, "tsconfig.json"), tsconfigRaw, "utf-8");
	}

	return projectDir;
}

// ---- Tests ----

interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

async function runTests(): Promise<TestResult[]> {
	const results: TestResult[] = [];

	// Load content model and extract image field names for comparison
	const contentModel = (await loadJson(
		join(FIXTURES_DIR, "content-model.json"),
	)) as {
		collections: Array<{
			fields: Array<{
				name: string;
				type: string;
				fields?: Array<{
					name: string;
					type: string;
					fields?: Array<{ name: string; type: string }>;
				}>;
			}>;
		}>;
	};
	const imageFields = extractImageFieldNames(contentModel.collections);

	// Ensure wrangler dev is running
	console.log("\n[Setup] Starting SonicJS via wrangler dev...");

	// Check if already running
	const alreadyRunning = await waitForUrl("http://localhost:8787", 3, 500);
	if (!alreadyRunning) {
		// Start wrangler dev in background
		spawn("bunx", ["wrangler", "dev", "--local"], {
			cwd: SONICJS_DIR,
			stdio: "ignore",
			detached: true,
		});

		console.log("[Setup] Waiting for SonicJS to be ready...");
		const ready = await waitForUrl("http://localhost:8787", 60, 2000);
		if (!ready) {
			results.push({
				name: "Start SonicJS",
				passed: false,
				error: "SonicJS did not become ready in time",
			});
			return results;
		}
		console.log("[Setup] SonicJS is ready!");
	}

	// Auth setup: register admin user and get JWT token
	console.log("[Setup] Setting up admin auth...");
	let apiToken = "test-api-key";
	try {
		const email = `cms-test-${Date.now()}@test.com`;
		const password = "testpassword123";

		// Register user
		const regRes = await fetch("http://localhost:8787/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password, name: "CMS Test Admin" }),
		});
		const regData = (await regRes.json()) as {
			token?: string;
			user?: { id?: string };
			error?: string;
		};

		if (regData.token && regData.user?.id) {
			// Promote to admin via wrangler d1 execute
			const promoteResult = await runCommand(
				"bunx",
				[
					"wrangler",
					"d1",
					"execute",
					"DB",
					"--local",
					"--command",
					`UPDATE users SET role = 'admin' WHERE email = '${email}'`,
				],
				{ cwd: SONICJS_DIR },
			);

			if (promoteResult.code === 0) {
				// Re-login to get token with admin role
				const loginRes = await fetch("http://localhost:8787/auth/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, password }),
				});
				const loginData = (await loginRes.json()) as {
					token?: string;
					user?: { role?: string };
				};
				if (loginData.token) {
					apiToken = loginData.token;
					console.log(
						`[Setup] Admin auth ready (role: ${loginData.user?.role})`,
					);
				}
			}
		}
	} catch (err) {
		console.log(`[Setup] Auth setup warning: ${err}. Using default token.`);
	}

	// Create isolated temp project
	console.log("[Setup] Creating temp project...");
	const tempProject = await createTempProject();

	// Update cms.config.json with the real JWT token
	await writeFile(
		join(tempProject, "cms.config.json"),
		JSON.stringify(
			{ adapter: "sonicjs", url: "http://localhost:8787", apiKey: apiToken },
			null,
			2,
		),
		"utf-8",
	);
	console.log(`[Setup] Temp project at: ${tempProject}`);

	// ---- Test 1: Push fixtures ----
	console.log("\n[Test 1] Push fixtures...");
	try {
		const pushResult = await runCommand("npx", ["tsx", "cms/cli.ts", "push"], {
			cwd: tempProject,
		});

		if (pushResult.code !== 0) {
			results.push({
				name: "Push fixtures",
				passed: false,
				error: `Exit code ${pushResult.code}: ${pushResult.stderr}\n${pushResult.stdout}`,
			});
		} else {
			results.push({ name: "Push fixtures", passed: true });
		}
	} catch (err) {
		results.push({
			name: "Push fixtures",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 2: Pull to temp project (overwriting pushed content) ----
	console.log("\n[Test 2] Pull from CMS...");
	// Clear src/content and src/data to verify pull writes them fresh
	const pullContentDir = join(tempProject, "src", "content");
	const pullDataDir = join(tempProject, "src", "data");
	if (existsSync(pullContentDir)) {
		await runCommand("rm", ["-rf", pullContentDir]);
	}
	if (existsSync(pullDataDir)) {
		await runCommand("rm", ["-rf", pullDataDir]);
	}

	try {
		const pullResult = await runCommand("npx", ["tsx", "cms/cli.ts", "pull"], {
			cwd: tempProject,
		});

		if (pullResult.code !== 0) {
			results.push({
				name: "Pull from CMS",
				passed: false,
				error: `Exit code ${pullResult.code}: ${pullResult.stderr}\n${pullResult.stdout}`,
			});
		} else {
			// Verify files were actually written
			const hasDoctors = existsSync(
				join(pullContentDir, "doctors", "jane-doe.json"),
			);
			const hasBlog = existsSync(
				join(pullContentDir, "blog", "hello-world.json"),
			);
			const hasProcedures = existsSync(
				join(pullContentDir, "procedures", "cardiac-catheterization.json"),
			);
			const hasAbout = existsSync(join(pullDataDir, "about.json"));
			const hasNav = existsSync(
				join(pullDataDir, "globals", "navigation.json"),
			);

			if (!hasDoctors || !hasBlog || !hasProcedures || !hasAbout || !hasNav) {
				const missing = [
					!hasDoctors && "doctors/jane-doe.json",
					!hasBlog && "blog/hello-world.json",
					!hasProcedures && "procedures/cardiac-catheterization.json",
					!hasAbout && "about.json",
					!hasNav && "globals/navigation.json",
				]
					.filter(Boolean)
					.join(", ");
				results.push({
					name: "Pull from CMS",
					passed: false,
					error: `Missing files after pull: ${missing}`,
				});
			} else {
				results.push({ name: "Pull from CMS", passed: true });
			}
		}
	} catch (err) {
		results.push({
			name: "Pull from CMS",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 3: Diff fixture vs pulled output (doctors) ----
	console.log("\n[Test 3] Diff fixture vs pulled (doctors/jane-doe)...");
	try {
		const fixtureData = (await loadJson(
			join(FIXTURES_DIR, "src", "content", "doctors", "jane-doe.json"),
		)) as Record<string, unknown>;
		const pulledData = (await loadJson(
			join(pullContentDir, "doctors", "jane-doe.json"),
		)) as Record<string, unknown>;

		const diff = deepEqualWithUrlTolerance(
			fixtureData,
			pulledData,
			imageFields,
		);
		if (diff) {
			results.push({
				name: "Diff fixture vs pulled (doctors/jane-doe)",
				passed: false,
				error: `Mismatch at ${diff.path}: expected ${JSON.stringify(diff.aVal)}, got ${JSON.stringify(diff.bVal)}`,
			});
		} else {
			results.push({
				name: "Diff fixture vs pulled (doctors/jane-doe)",
				passed: true,
			});
		}
	} catch (err) {
		results.push({
			name: "Diff fixture vs pulled (doctors/jane-doe)",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 4: Diff fixture vs pulled output (blog) ----
	console.log("\n[Test 4] Diff fixture vs pulled (blog/hello-world)...");
	try {
		const fixtureData = (await loadJson(
			join(FIXTURES_DIR, "src", "content", "blog", "hello-world.json"),
		)) as Record<string, unknown>;
		const pulledData = (await loadJson(
			join(pullContentDir, "blog", "hello-world.json"),
		)) as Record<string, unknown>;

		const diff = deepEqualWithUrlTolerance(
			fixtureData,
			pulledData,
			imageFields,
		);
		if (diff) {
			results.push({
				name: "Diff fixture vs pulled (blog/hello-world)",
				passed: false,
				error: `Mismatch at ${diff.path}: expected ${JSON.stringify(diff.aVal)}, got ${JSON.stringify(diff.bVal)}`,
			});
		} else {
			results.push({
				name: "Diff fixture vs pulled (blog/hello-world)",
				passed: true,
			});
		}
	} catch (err) {
		results.push({
			name: "Diff fixture vs pulled (blog/hello-world)",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 5: Diff fixture vs pulled output (procedures) ----
	console.log("\n[Test 5] Diff fixture vs pulled (procedures)...");
	try {
		const fixtureData = (await loadJson(
			join(
				FIXTURES_DIR,
				"src",
				"content",
				"procedures",
				"cardiac-catheterization.json",
			),
		)) as Record<string, unknown>;
		const pulledData = (await loadJson(
			join(pullContentDir, "procedures", "cardiac-catheterization.json"),
		)) as Record<string, unknown>;

		const diff = deepEqualWithUrlTolerance(
			fixtureData,
			pulledData,
			imageFields,
		);
		if (diff) {
			results.push({
				name: "Diff fixture vs pulled (procedures)",
				passed: false,
				error: `Mismatch at ${diff.path}: expected ${JSON.stringify(diff.aVal)}, got ${JSON.stringify(diff.bVal)}`,
			});
		} else {
			results.push({
				name: "Diff fixture vs pulled (procedures)",
				passed: true,
			});
		}
	} catch (err) {
		results.push({
			name: "Diff fixture vs pulled (procedures)",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 6: Diff fixture vs pulled output (about singleton) ----
	console.log("\n[Test 6] Diff fixture vs pulled (about singleton)...");
	try {
		const fixtureData = (await loadJson(
			join(FIXTURES_DIR, "src", "data", "about.json"),
		)) as Record<string, unknown>;
		const pulledData = (await loadJson(
			join(pullDataDir, "about.json"),
		)) as Record<string, unknown>;

		const diff = deepEqualWithUrlTolerance(
			fixtureData,
			pulledData,
			imageFields,
		);
		if (diff) {
			results.push({
				name: "Diff fixture vs pulled (about singleton)",
				passed: false,
				error: `Mismatch at ${diff.path}: expected ${JSON.stringify(diff.aVal)}, got ${JSON.stringify(diff.bVal)}`,
			});
		} else {
			results.push({
				name: "Diff fixture vs pulled (about singleton)",
				passed: true,
			});
		}
	} catch (err) {
		results.push({
			name: "Diff fixture vs pulled (about singleton)",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 7: Diff fixture vs pulled output (navigation global) ----
	console.log("\n[Test 7] Diff fixture vs pulled (navigation global)...");
	try {
		const fixtureData = (await loadJson(
			join(FIXTURES_DIR, "src", "data", "globals", "navigation.json"),
		)) as Record<string, unknown>;
		const pulledData = (await loadJson(
			join(pullDataDir, "globals", "navigation.json"),
		)) as Record<string, unknown>;

		const diff = deepEqualWithUrlTolerance(
			fixtureData,
			pulledData,
			imageFields,
		);
		if (diff) {
			results.push({
				name: "Diff fixture vs pulled (navigation global)",
				passed: false,
				error: `Mismatch at ${diff.path}: expected ${JSON.stringify(diff.aVal)}, got ${JSON.stringify(diff.bVal)}`,
			});
		} else {
			results.push({
				name: "Diff fixture vs pulled (navigation global)",
				passed: true,
			});
		}
	} catch (err) {
		results.push({
			name: "Diff fixture vs pulled (navigation global)",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 8: Idempotent push (second push should succeed, no duplicates) ----
	console.log("\n[Test 8] Idempotent push...");
	try {
		// Reset src to fixture data for clean push
		await copyDirRewrite(
			join(FIXTURES_DIR, "src", "content"),
			join(tempProject, "src", "content"),
			rewriteImagePathsInJson,
		);
		await copyDirRewrite(
			join(FIXTURES_DIR, "src", "data"),
			join(tempProject, "src", "data"),
			rewriteImagePathsInJson,
		);

		// Count entries after first push and pull
		const count1Result = await runCommand(
			"npx",
			["tsx", "cms/cli.ts", "push"],
			{
				cwd: tempProject,
			},
		);
		if (count1Result.code !== 0) {
			results.push({
				name: "Idempotent push",
				passed: false,
				error: `First push failed: ${count1Result.stderr}`,
			});
		} else {
			// Pull to clear src dirs
			await runCommand("npx", ["tsx", "cms/cli.ts", "pull"], {
				cwd: tempProject,
			});

			// Count files in src/content and src/data after first pull
			async function countFiles(dir: string): Promise<number> {
				const { readdir } = await import("node:fs/promises");
				let count = 0;
				async function walk(d: string): Promise<void> {
					const entries = await readdir(d, { withFileTypes: true });
					for (const entry of entries) {
						const fullPath = join(d, entry.name);
						if (entry.isDirectory()) {
							await walk(fullPath);
						} else {
							count++;
						}
					}
				}
				await walk(dir);
				return count;
			}
			const firstCount =
				(await countFiles(join(tempProject, "src", "content"))) +
				(await countFiles(join(tempProject, "src", "data")));

			// Second push
			const pushResult = await runCommand(
				"npx",
				["tsx", "cms/cli.ts", "push"],
				{
					cwd: tempProject,
				},
			);

			if (pushResult.code !== 0) {
				results.push({
					name: "Idempotent push",
					passed: false,
					error: `Second push failed: ${pushResult.stderr}`,
				});
			} else {
				// Pull and count again
				await runCommand("npx", ["tsx", "cms/cli.ts", "pull"], {
					cwd: tempProject,
				});
				const secondCount =
					(await countFiles(join(tempProject, "src", "content"))) +
					(await countFiles(join(tempProject, "src", "data")));

				if (firstCount !== secondCount) {
					results.push({
						name: "Idempotent push",
						passed: false,
						error: `Duplicate entries detected: first had ${firstCount} files, second had ${secondCount}`,
					});
				} else {
					results.push({ name: "Idempotent push", passed: true });
				}
			}
		}
	} catch (err) {
		results.push({
			name: "Idempotent push",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 9: Idempotent pull (pull twice produces identical output) ----
	console.log("\n[Test 9] Idempotent pull...");
	try {
		// Pull #1: clear and pull
		if (existsSync(pullContentDir)) {
			await runCommand("rm", ["-rf", pullContentDir]);
		}
		if (existsSync(pullDataDir)) {
			await runCommand("rm", ["-rf", pullDataDir]);
		}

		const pull1Result = await runCommand("npx", ["tsx", "cms/cli.ts", "pull"], {
			cwd: tempProject,
		});

		if (pull1Result.code !== 0) {
			results.push({
				name: "Idempotent pull",
				passed: false,
				error: `First pull failed: ${pull1Result.stderr}`,
			});
		} else {
			// Save pull #1 output to separate directories for comparison
			const savedContentDir = join(TMP_DIR, "idempotent-saved", "content");
			const savedDataDir = join(TMP_DIR, "idempotent-saved", "data");
			if (existsSync(join(TMP_DIR, "idempotent-saved"))) {
				await runCommand("rm", ["-rf", join(TMP_DIR, "idempotent-saved")]);
			}
			await copyDir(pullContentDir, savedContentDir);
			await copyDir(pullDataDir, savedDataDir);

			// Pull #2: clear and pull again
			if (existsSync(pullContentDir)) {
				await runCommand("rm", ["-rf", pullContentDir]);
			}
			if (existsSync(pullDataDir)) {
				await runCommand("rm", ["-rf", pullDataDir]);
			}

			const pull2Result = await runCommand(
				"npx",
				["tsx", "cms/cli.ts", "pull"],
				{ cwd: tempProject },
			);

			if (pull2Result.code !== 0) {
				results.push({
					name: "Idempotent pull",
					passed: false,
					error: `Second pull failed: ${pull2Result.stderr}`,
				});
			} else {
				// Byte-identical comparison: saved (pull #1) vs current (pull #2)
				const mismatch =
					(await compareDirectoryTrees(savedContentDir, pullContentDir)) ??
					(await compareDirectoryTrees(savedDataDir, pullDataDir));

				if (mismatch) {
					results.push({
						name: "Idempotent pull",
						passed: false,
						error: `Pull outputs are not byte-identical: ${mismatch}`,
					});
				} else {
					results.push({ name: "Idempotent pull", passed: true });
				}

				// Clean up saved directory
				await runCommand("rm", ["-rf", join(TMP_DIR, "idempotent-saved")]);
			}
		}
	} catch (err) {
		results.push({
			name: "Idempotent pull",
			passed: false,
			error: String(err),
		});
	}

	console.log("\n[Test 10] Diff fixture vs pulled (doctors/john-smith)...");
	try {
		const fixtureData = (await loadJson(
			join(FIXTURES_DIR, "src", "content", "doctors", "john-smith.json"),
		)) as Record<string, unknown>;
		const pulledData = (await loadJson(
			join(pullContentDir, "doctors", "john-smith.json"),
		)) as Record<string, unknown>;

		const diff = deepEqualWithUrlTolerance(
			fixtureData,
			pulledData,
			imageFields,
		);
		if (diff) {
			results.push({
				name: "Diff fixture vs pulled (doctors/john-smith)",
				passed: false,
				error: `Mismatch at ${diff.path}: expected ${JSON.stringify(diff.aVal)}, got ${JSON.stringify(diff.bVal)}`,
			});
		} else {
			results.push({
				name: "Diff fixture vs pulled (doctors/john-smith)",
				passed: true,
			});
		}
	} catch (err) {
		results.push({
			name: "Diff fixture vs pulled (doctors/john-smith)",
			passed: false,
			error: String(err),
		});
	}

	// ---- Test 11: Error handling — broken image path ----
	console.log("\n[Test 11] Error handling (broken image path)...");
	try {
		// Create a temp project variant with a broken image path
		const errorProject = join(TMP_DIR, "error-project");
		if (existsSync(errorProject)) {
			await runCommand("rm", ["-rf", errorProject]);
		}

		// Copy temp project as base
		await copyDir(tempProject, errorProject);

		// Overwrite doctors/jane-doe.json with a broken image path
		const brokenEntry = {
			slug: "jane-doe-broken",
			name: "Dr. Broken",
			title: "Test",
			bio: "<p>Test</p>",
			portrait: "nonexistent/path/broken-image.jpg",
			yearsExperience: 1,
			available: false,
		};
		await writeFile(
			join(errorProject, "src", "content", "doctors", "jane-doe-broken.json"),
			JSON.stringify(brokenEntry, null, 2),
			"utf-8",
		);

		// Also add broken image to asset manifest
		const brokenManifest = {
			entries: [
				{
					localPath: "nonexistent/path/broken-image.jpg",
					originalUrl: "https://example.com/broken.jpg",
				},
			],
		};
		await writeFile(
			join(errorProject, "asset-manifest.json"),
			JSON.stringify(brokenManifest, null, 2),
			"utf-8",
		);

		const pushResult = await runCommand("npx", ["tsx", "cms/cli.ts", "push"], {
			cwd: errorProject,
		});

		// Should fail (exit code 1) due to missing image
		if (pushResult.code !== 0) {
			// Check that error mentions image upload
			const output = `${pushResult.stdout}\n${pushResult.stderr}`;
			if (
				output.includes("Image upload") ||
				output.includes("ENOENT") ||
				output.includes("error")
			) {
				results.push({
					name: "Error handling (broken image path)",
					passed: true,
				});
			} else {
				results.push({
					name: "Error handling (broken image path)",
					passed: false,
					error: `Push failed but error message unclear: ${output}`,
				});
			}
		} else {
			results.push({
				name: "Error handling (broken image path)",
				passed: false,
				error: "Push should have failed with broken image path",
			});
		}
	} catch (err) {
		results.push({
			name: "Error handling (broken image path)",
			passed: false,
			error: String(err),
		});
	}

	return results;
}

// ---- Main ----

async function main(): Promise<void> {
	console.log("=".repeat(60));
	console.log("CMS Integration Tests");
	console.log("=".repeat(60));

	const results = await runTests();

	console.log(`\n${"=".repeat(60)}`);
	console.log("Results");
	console.log("=".repeat(60));

	let passed = 0;
	let failed = 0;

	for (const result of results) {
		const status = result.passed ? "PASS" : "FAIL";
		console.log(`[${status}] ${result.name}`);
		if (result.error) {
			console.log(`       ${result.error}`);
		}
		if (result.passed) passed++;
		else failed++;
	}

	console.log(`\n${passed}/${results.length} tests passed`);

	// Cleanup
	console.log("\n[Cleanup] Killing wrangler dev...");
	try {
		await runCommand("pkill", ["-f", "wrangler dev"]);
	} catch {
		// Ignore cleanup errors
	}

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
