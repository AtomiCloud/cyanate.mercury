import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadPageForHarmonizePrepare,
	preferredChromePathsFile,
} from "./harmonize-prepare.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("preferredChromePathsFile", () => {
	it("prefers shape-normalized chrome when present", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harmonize-prepare-"));
		tempDirs.push(dir);
		const outputDir = join(dir, "output");
		await mkdir(outputDir, { recursive: true });
		await writeFile(
			join(outputDir, "chrome-classify.json"),
			'{"chromePaths":[{"sourcePath":"header.logo"}]}',
		);
		await writeFile(
			join(outputDir, "shape-normalized-chrome.json"),
			'{"chromePaths":[{"sourcePath":"header.logo","suggestedCanonical":"header.logo.src"}]}',
		);

		const chosen = await preferredChromePathsFile(dir);
		expect(chosen).toBe(join(outputDir, "shape-normalized-chrome.json"));
	});
});

describe("loadPageForHarmonizePrepare", () => {
	it("prefers the materialized shape-normalized chrome tree when present", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harmonize-prepare-"));
		tempDirs.push(dir);
		const outputDir = join(dir, "output");
		await mkdir(outputDir, { recursive: true });
		await writeFile(
			join(dir, "content.json"),
			JSON.stringify({
				url: "/sports-physio/",
				content: {
					header: { logo: "/logo.svg" },
				},
			}),
		);
		await writeFile(
			join(outputDir, "shape-normalized-chrome.materialized.json"),
			JSON.stringify({
				header: { logo: { src: "/logo.svg" } },
			}),
		);
		await writeFile(
			join(outputDir, "shape-normalized-chrome.provenance.json"),
			JSON.stringify([
				{
					sourcePath: "header.logo",
					candidatePath: "header.logo.src",
					materializedPath: "header.logo.src",
				},
			]),
		);

		const loaded = await loadPageForHarmonizePrepare(dir, "abc123");
		expect(loaded).not.toBeNull();
		expect(loaded?.content).toEqual({
			header: { logo: { src: "/logo.svg" } },
		});
		expect(loaded?.chromePaths).toEqual([
			{
				sourcePath: "header.logo.src",
				suggestedCanonical: "header.logo.src",
			},
		]);
	});

	it("loads shape-normalized chrome ahead of raw classify output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harmonize-prepare-"));
		tempDirs.push(dir);
		const outputDir = join(dir, "output");
		await mkdir(outputDir, { recursive: true });
		await writeFile(
			join(dir, "content.json"),
			JSON.stringify({
				url: "/sports-physio/",
				content: {
					header: { logo: "/logo.svg" },
				},
			}),
		);
		await writeFile(
			join(outputDir, "chrome-classify.json"),
			JSON.stringify({
				chromePaths: [{ sourcePath: "header.logo" }],
			}),
		);
		await writeFile(
			join(outputDir, "shape-normalized-chrome.json"),
			JSON.stringify({
				chromePaths: [
					{
						sourcePath: "header.logo",
						suggestedCanonical: "header.logo.src",
					},
				],
			}),
		);

		const loaded = await loadPageForHarmonizePrepare(dir, "abc123");
		expect(loaded).not.toBeNull();
		expect(loaded?.chromePaths).toEqual([
			{
				sourcePath: "header.logo",
				suggestedCanonical: "header.logo.src",
			},
		]);
	});

	it("filters identity-key provenance rows from materialized digest input", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harmonize-prepare-"));
		tempDirs.push(dir);
		const outputDir = join(dir, "output");
		await mkdir(outputDir, { recursive: true });
		await writeFile(
			join(dir, "content.json"),
			JSON.stringify({
				url: "/contact/",
				content: {
					footer: { form: { fields: [{ name: "email", type: "email" }] } },
				},
			}),
		);
		await writeFile(
			join(outputDir, "shape-normalized-chrome.materialized.json"),
			JSON.stringify({
				footer: { form: { fields: { email: { type: "email" } } } },
			}),
		);
		await writeFile(
			join(outputDir, "shape-normalized-chrome.provenance.json"),
			JSON.stringify([
				{
					sourcePath: "footer.form.fields[0].name",
					candidatePath: "footer.form.fields.email",
					role: "identity-key",
				},
				{
					sourcePath: "footer.form.fields[0].type",
					candidatePath: "footer.form.fields.email.type",
					materializedPath: "footer.form.fields.email.type",
				},
			]),
		);

		const loaded = await loadPageForHarmonizePrepare(dir, "abc123");
		expect(loaded?.chromePaths).toEqual([
			{
				sourcePath: "footer.form.fields.email.type",
				suggestedCanonical: "footer.form.fields.email.type",
			},
		]);
	});
});
