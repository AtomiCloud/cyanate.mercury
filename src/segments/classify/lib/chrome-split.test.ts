import { describe, expect, it } from "bun:test";
import { extractChromeByPaths, splitByChromePaths } from "./chrome-split.js";

describe("splitByChromePaths", () => {
	it("assigns leaves to chrome or body by exact path membership", () => {
		const content = {
			header: { logo: { src: "/logo.svg" }, title: "Acme" },
			title: "Welcome",
			body: { copy: "hello" },
		};
		const { chrome, body } = splitByChromePaths(content, [
			"header.logo.src",
			"header.title",
		]);
		expect(chrome).toEqual({
			header: { logo: { src: "/logo.svg" }, title: "Acme" },
		});
		expect(body).toEqual({
			title: "Welcome",
			body: { copy: "hello" },
		});
	});

	it("splits arrays leaf-by-leaf and compacts both sides", () => {
		const content = {
			header: {
				nav: {
					links: [
						{ href: "/", label: "Home" },
						{ href: "/about", label: "About" },
					],
				},
			},
		};
		const { chrome, body } = splitByChromePaths(content, [
			"header.nav.links[0].href",
			"header.nav.links[0].label",
		]);
		// Chrome keeps only link 0 (both fields chrome), body keeps only link 1.
		expect(chrome).toEqual({
			header: { nav: { links: [{ href: "/", label: "Home" }] } },
		});
		expect(body).toEqual({
			header: { nav: { links: [{ href: "/about", label: "About" }] } },
		});
	});

	it("compacts mixed arrays without sparse gaps", () => {
		const content = {
			items: [
				{ a: 1, b: 2 },
				{ a: 3, b: 4 },
				{ a: 5, b: 6 },
			],
		};
		const { chrome, body } = splitByChromePaths(content, ["items[1].a"]);
		// One chrome leaf → single compacted element on chrome side.
		expect(chrome).toEqual({ items: [{ a: 3 }] });
		// Body keeps every other leaf, compacted in original order.
		expect(body).toEqual({
			items: [{ a: 1, b: 2 }, { b: 4 }, { a: 5, b: 6 }],
		});
	});

	it("returns empty shell for the side with no leaves", () => {
		const content = { title: "Welcome" };
		const allChrome = splitByChromePaths(content, ["title"]);
		expect(allChrome.chrome).toEqual({ title: "Welcome" });
		expect(allChrome.body).toEqual({});

		const noChrome = splitByChromePaths(content, []);
		expect(noChrome.chrome).toEqual({});
		expect(noChrome.body).toEqual({ title: "Welcome" });
	});

	it("preserves primitive leaves on null/empty container", () => {
		const content = { meta: null, tags: [], title: "x" };
		const { chrome, body } = splitByChromePaths(content, ["meta", "tags"]);
		expect(chrome).toEqual({ meta: null, tags: [] });
		expect(body).toEqual({ title: "x" });
	});

	it("the split is total and disjoint", () => {
		// Every primitive in the input ends up on exactly one side.
		const content = {
			a: 1,
			b: { c: 2, d: [3, 4] },
		};
		const paths = ["a", "b.d[0]"];
		const { chrome, body } = splitByChromePaths(content, paths);
		const chromeLeaves = primitiveCount(chrome);
		const bodyLeaves = primitiveCount(body);
		expect(chromeLeaves + bodyLeaves).toBe(primitiveCount(content));
	});
});

describe("extractChromeByPaths", () => {
	it("can preserve original array positions for shape-normalize prompts", () => {
		const content = {
			items: [
				{ kind: "body", value: 1 },
				{ kind: "chrome", value: 2 },
				{ kind: "body", value: 3 },
				{ kind: "chrome", value: 4 },
			],
		};
		const chrome = extractChromeByPaths(
			content,
			["items[1].kind", "items[1].value", "items[3].kind", "items[3].value"],
			{ compactArrays: false },
		);
		expect(chrome).toEqual({
			items: [
				null,
				{ kind: "chrome", value: 2 },
				null,
				{ kind: "chrome", value: 4 },
			],
		});
	});
});

function primitiveCount(value: unknown): number {
	if (value === null) return 1;
	if (typeof value !== "object") return 1;
	if (Array.isArray(value)) {
		return value.reduce<number>((acc, v) => acc + primitiveCount(v), 0);
	}
	return Object.values(value as Record<string, unknown>).reduce<number>(
		(acc, v) => acc + primitiveCount(v),
		0,
	);
}
