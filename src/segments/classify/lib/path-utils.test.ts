import { describe, expect, it } from "bun:test";
import {
	classifyUnitHash,
	collapseArrayIndices,
	countWildcards,
	isLeaf,
	pathHasWildcard,
	readPath,
} from "./path-utils.js";

describe("collapseArrayIndices", () => {
	it("replaces a single index with [*]", () => {
		expect(collapseArrayIndices("nav[0].href")).toBe("nav[*].href");
	});

	it("replaces multiple indices in the same path", () => {
		expect(collapseArrayIndices("nav[0].items[3].href")).toBe(
			"nav[*].items[*].href",
		);
	});

	it("handles multi-digit indices", () => {
		expect(collapseArrayIndices("items[12]")).toBe("items[*]");
	});

	it("leaves paths without brackets untouched", () => {
		expect(collapseArrayIndices("header.title")).toBe("header.title");
	});

	it("leaves existing [*] untouched", () => {
		expect(collapseArrayIndices("nav[*].items[2]")).toBe("nav[*].items[*]");
	});
});

describe("pathHasWildcard", () => {
	it("detects collapsed array paths", () => {
		expect(pathHasWildcard("nav[*].href")).toBe(true);
		expect(pathHasWildcard("nav.items[*]")).toBe(true);
	});
	it("rejects scalar paths", () => {
		expect(pathHasWildcard("header.title")).toBe(false);
	});
});

describe("countWildcards", () => {
	it("returns 0 for scalar paths", () => {
		expect(countWildcards("header.title")).toBe(0);
	});
	it("counts a single wildcard", () => {
		expect(countWildcards("nav[*].href")).toBe(1);
	});
	it("counts multiple wildcards", () => {
		expect(countWildcards("nav[*].children[*].href")).toBe(2);
	});
	it("ignores concrete indices", () => {
		expect(countWildcards("nav[0].items[3]")).toBe(0);
	});
});

describe("classifyUnitHash", () => {
	it("is deterministic for the same URL", () => {
		expect(classifyUnitHash("/a/")).toBe(classifyUnitHash("/a/"));
	});

	it("differs for different URLs", () => {
		expect(classifyUnitHash("/a/")).not.toBe(classifyUnitHash("/b/"));
	});

	it("returns a 12-char hex string", () => {
		const h = classifyUnitHash("/");
		expect(h).toMatch(/^[0-9a-f]{12}$/);
	});
});

describe("readPath", () => {
	const page = {
		header: {
			logo: { src: "/logo.svg", alt: "Acme" },
			nav: {
				links: [
					{ href: "/", label: "Home" },
					{ href: "/about", label: "About" },
				],
			},
		},
		title: "Welcome",
		empty: {},
		list: [],
		leafNull: null,
	};

	it("resolves nested object paths", () => {
		expect(readPath(page, "header.logo.src")).toBe("/logo.svg");
		expect(readPath(page, "title")).toBe("Welcome");
	});

	it("resolves array indices via bracket notation", () => {
		expect(readPath(page, "header.nav.links[0].href")).toBe("/");
		expect(readPath(page, "header.nav.links[1].label")).toBe("About");
	});

	it("returns undefined for missing keys", () => {
		expect(readPath(page, "header.missing")).toBeUndefined();
		expect(readPath(page, "nope")).toBeUndefined();
	});

	it("returns undefined for out-of-range indices", () => {
		expect(readPath(page, "header.nav.links[99].href")).toBeUndefined();
	});

	it("returns undefined when traversing into a primitive", () => {
		expect(readPath(page, "title.nope")).toBeUndefined();
	});

	it("distinguishes null leaf (found) from missing key", () => {
		expect(readPath(page, "leafNull")).toBeNull();
		expect(readPath(page, "leafNull.anything")).toBeUndefined();
	});

	it("returns empty containers intact", () => {
		expect(readPath(page, "empty")).toEqual({});
		expect(readPath(page, "list")).toEqual([]);
	});

	it("rejects treating an array as an object (missing numeric bracket)", () => {
		// "header.nav.links.0" is treated as object-key "0" on the array → miss.
		expect(readPath(page, "header.nav.links.0")).toBeUndefined();
	});

	it("returns the root for the empty path", () => {
		expect(readPath(page, "")).toBe(page);
	});
});

describe("isLeaf", () => {
	it("treats primitives as leaves", () => {
		expect(isLeaf("x")).toBe(true);
		expect(isLeaf(0)).toBe(true);
		expect(isLeaf(true)).toBe(true);
		expect(isLeaf(null)).toBe(true);
	});

	it("treats empty containers as leaves", () => {
		expect(isLeaf({})).toBe(true);
		expect(isLeaf([])).toBe(true);
	});

	it("treats non-empty containers as non-leaves", () => {
		expect(isLeaf({ a: 1 })).toBe(false);
		expect(isLeaf([1])).toBe(false);
	});

	it("rejects undefined", () => {
		expect(isLeaf(undefined)).toBe(false);
	});
});
