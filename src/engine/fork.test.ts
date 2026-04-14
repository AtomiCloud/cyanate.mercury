import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupForks,
	computeManifest,
	createForks,
	diffFork,
	mergeForks,
} from "./fork.js";

describe("fork", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "fork-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	/** Create a simple workdir with a few files for testing. */
	async function makeWorkdir(): Promise<string> {
		const workdir = join(tmpDir, "workdir");
		await mkdir(join(workdir, "src"), { recursive: true });
		await writeFile(join(workdir, "src", "index.ts"), "export const x = 1;");
		await writeFile(join(workdir, "README.md"), "# Hello");
		return workdir;
	}

	it("createForks creates isolated copies", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a", "b"], 3);

		expect(plan.forks).toHaveLength(2);
		expect(plan.forks[0].id).toBe("a");
		expect(plan.forks[1].id).toBe("b");

		// Verify iteration prefix in fork directory names
		expect(plan.forks[0].dir).toContain("iteration-3-fork-a");
		expect(plan.forks[1].dir).toContain("iteration-3-fork-b");

		// Verify both forks contain the original files
		for (const fork of plan.forks) {
			const indexContent = await readFile(
				join(fork.dir, "src", "index.ts"),
				"utf-8",
			);
			expect(indexContent).toBe("export const x = 1;");

			const readmeContent = await readFile(
				join(fork.dir, "README.md"),
				"utf-8",
			);
			expect(readmeContent).toBe("# Hello");
		}
	});

	it("createForks skips node_modules", async () => {
		const workdir = await makeWorkdir();

		// Add a node_modules dir
		await mkdir(join(workdir, "project", "node_modules", "foo"), {
			recursive: true,
		});
		await writeFile(
			join(workdir, "project", "node_modules", "foo", "bar.js"),
			"module.exports = 1;",
		);

		const plan = await createForks(workdir, ["x"], 3);

		// node_modules should NOT exist in the fork
		const forkDir = plan.forks[0].dir;
		const entries = await readdir(join(forkDir, "project"));
		expect(entries).not.toContain("node_modules");
	});

	it("diffFork detects added files", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a"], 3);

		// Add a new file to the fork
		await writeFile(join(plan.forks[0].dir, "new-file.txt"), "new content");

		const changes = await diffFork(plan, "a");
		const added = changes.filter((c) => c.type === "add");
		expect(added).toHaveLength(1);
		expect(added[0].path).toBe("new-file.txt");
		expect(added[0].forkId).toBe("a");
	});

	it("diffFork detects modified files", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a"], 3);

		// Modify an existing file in the fork
		await writeFile(
			join(plan.forks[0].dir, "src", "index.ts"),
			"export const x = 42;",
		);

		const changes = await diffFork(plan, "a");
		const modified = changes.filter((c) => c.type === "modify");
		expect(modified).toHaveLength(1);
		expect(modified[0].path).toBe(join("src", "index.ts"));
		expect(modified[0].forkId).toBe("a");
	});

	it("diffFork detects deleted files", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a"], 3);

		// Delete a file from the fork
		await rm(join(plan.forks[0].dir, "README.md"));

		const changes = await diffFork(plan, "a");
		const deleted = changes.filter((c) => c.type === "delete");
		expect(deleted).toHaveLength(1);
		expect(deleted[0].path).toBe("README.md");
		expect(deleted[0].forkId).toBe("a");
	});

	it("mergeForks applies non-overlapping changes", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a", "b"], 3);

		// Fork A: modify README.md
		await writeFile(join(plan.forks[0].dir, "README.md"), "# Updated by A");

		// Fork B: add a new file
		await writeFile(join(plan.forks[1].dir, "extra.txt"), "from fork B");

		const result = await mergeForks(plan);

		expect(result.status).toBe("clean");
		expect(result.applied).toHaveLength(2);

		// Verify changes landed in the original workdir
		const readme = await readFile(join(workdir, "README.md"), "utf-8");
		expect(readme).toBe("# Updated by A");

		const extra = await readFile(join(workdir, "extra.txt"), "utf-8");
		expect(extra).toBe("from fork B");
	});

	it("mergeForks detects conflicts", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a", "b"], 3);

		// Both forks modify the same file
		await writeFile(
			join(plan.forks[0].dir, "README.md"),
			"# Changed by fork A",
		);
		await writeFile(
			join(plan.forks[1].dir, "README.md"),
			"# Changed by fork B",
		);

		const result = await mergeForks(plan);

		expect(result.status).toBe("conflict");
		expect(result.conflicts).toBeDefined();
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts?.[0].path).toBe("README.md");
		expect(result.conflicts?.[0].forkIds).toContain("a");
		expect(result.conflicts?.[0].forkIds).toContain("b");
	});

	it("cleanupForks removes fork dirs", async () => {
		const workdir = await makeWorkdir();
		const plan = await createForks(workdir, ["a", "b"], 3);

		// Verify forks exist
		for (const fork of plan.forks) {
			const entries = await readdir(fork.dir);
			expect(entries.length).toBeGreaterThan(0);
		}

		await cleanupForks(plan);

		// Verify forks are removed
		for (const fork of plan.forks) {
			const exists = await readdir(fork.dir).then(
				() => true,
				() => false,
			);
			expect(exists).toBe(false);
		}
	});

	it("computeManifest skips node_modules and .astro", async () => {
		const workdir = await makeWorkdir();

		// Add dirs that should be skipped
		await mkdir(join(workdir, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(workdir, "node_modules", "pkg", "index.js"), "x");

		await mkdir(join(workdir, ".astro"), { recursive: true });
		await writeFile(join(workdir, ".astro", "cache.json"), "{}");

		const manifest = await computeManifest(workdir);

		// Should only have the 2 original files
		expect(manifest.size).toBe(2);
		expect(manifest.has(join("src", "index.ts"))).toBe(true);
		expect(manifest.has("README.md")).toBe(true);
	});
});
