import { describe, expect, it } from "bun:test";
import type { Registry } from "../../types.js";
import type {
	ArchitectureClassification,
	ComponentManifestOutput,
	ContentModelClassification,
	ContentModelOutput,
	InteractionClassification,
} from "./classify.js";
import {
	buildComponentManifestFromFiles,
	crossValidateClassifiers,
	detectConflicts,
	validateComponentManifestRefs,
	validateContentModelRefs,
	validateRegistryCompleteness,
	validateRoutePatterns,
} from "./classify.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validArch: ArchitectureClassification = {
	layouts: {
		default: {
			description: "Default layout",
			page_types: ["landing", "about"],
		},
		blog: { description: "Blog layout", page_types: ["blog"] },
	},
	routes: [
		{ pattern: "/", pageType: "landing" },
		{ pattern: "/about", pageType: "about" },
		{ pattern: "/blog", pageType: "blog" },
		{ pattern: "/blog/[slug]", pageType: "blog" },
	],
};

const validCM: ContentModelClassification = {
	collections: {
		blog: { source_pagetype: "blog", slug_field: "slug" },
	},
	listings: {
		blog_index: { route: "/blog", paginated: true },
	},
};

const validInteraction: InteractionClassification = {
	patterns: [
		{
			id: "nav-mobile",
			type: "modal",
			pageType: "landing",
			description: "Mobile nav",
		},
	],
};

// ---------------------------------------------------------------------------
// crossValidateClassifiers
// ---------------------------------------------------------------------------

describe("crossValidateClassifiers", () => {
	it("all types present → valid", () => {
		const result = crossValidateClassifiers(
			validArch,
			validCM,
			validInteraction,
			["landing", "about", "blog"],
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("missing type → specific error", () => {
		const result = crossValidateClassifiers(
			validArch,
			validCM,
			validInteraction,
			["landing", "about", "blog", "contact"],
		);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("contact"))).toBe(true);
	});

	it("empty classifiers → all types missing", () => {
		const empty: ArchitectureClassification = {
			layouts: {},
			routes: [],
		};
		const emptyCM: ContentModelClassification = {
			collections: {},
			listings: {},
		};
		const emptyInt: InteractionClassification = { patterns: [] };

		const result = crossValidateClassifiers(empty, emptyCM, emptyInt, [
			"landing",
		]);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
	});

	it("collection references unknown page type → error", () => {
		const cm: ContentModelClassification = {
			collections: {
				orphan: { source_pagetype: "orphan", slug_field: "slug" },
			},
			listings: {},
		};

		const result = crossValidateClassifiers(validArch, cm, validInteraction, [
			"landing",
			"about",
			"blog",
		]);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some(
				(e) => e.includes("orphan") && e.includes("unknown page type"),
			),
		).toBe(true);
	});

	it("interaction pattern references unknown page type → error", () => {
		const interaction: InteractionClassification = {
			patterns: [
				{
					id: "bad-pattern",
					type: "modal",
					pageType: "nonexistent",
					description: "Bad",
				},
			],
		};

		const result = crossValidateClassifiers(validArch, validCM, interaction, [
			"landing",
			"about",
			"blog",
		]);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some(
				(e) => e.includes("bad-pattern") && e.includes("nonexistent"),
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

describe("detectConflicts", () => {
	it("same page type in different layouts → conflict", () => {
		const arch: ArchitectureClassification = {
			layouts: {
				a: { description: "A", page_types: ["blog"] },
				b: { description: "B", page_types: ["blog"] },
			},
			routes: [{ pattern: "/blog/[slug]", pageType: "blog" }],
		};

		const result = detectConflicts(arch, validCM);
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.conflicts[0].type).toBe("layout_conflict");
	});

	it("no conflicts → empty array", () => {
		const result = detectConflicts(validArch, validCM);
		expect(result.conflicts).toEqual([]);
	});

	it("collection without route → missing_route conflict", () => {
		const arch: ArchitectureClassification = {
			layouts: { default: { description: "D", page_types: ["landing"] } },
			routes: [],
		};
		const cm: ContentModelClassification = {
			collections: {
				blog: { source_pagetype: "blog", slug_field: "slug" },
			},
			listings: {},
		};

		const result = detectConflicts(arch, cm);
		expect(result.conflicts.some((c) => c.type === "missing_route")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateRoutePatterns
// ---------------------------------------------------------------------------

describe("validateRoutePatterns", () => {
	it("/blog/[slug] and /blog/[id] → conflict", () => {
		const routes = [
			{ pattern: "/blog/[slug]", pageType: "blog" },
			{ pattern: "/blog/[id]", pageType: "blog" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(false);
		expect(result.conflicts.length).toBe(1);
		expect(result.conflicts[0].reason).toContain("dynamic segment");
	});

	it("/blog/[slug] and /about → no conflict (different segment count)", () => {
		const routes = [
			{ pattern: "/blog/[slug]", pageType: "blog" },
			{ pattern: "/about", pageType: "about" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(true);
	});

	it("/blog/[slug] and /blog/archive → conflict (static vs dynamic)", () => {
		const routes = [
			{ pattern: "/blog/[slug]", pageType: "blog" },
			{ pattern: "/blog/archive", pageType: "blog_archive" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(false);
		expect(result.conflicts.length).toBe(1);
		expect(result.conflicts[0].reason).toContain(
			"Static segment conflicts with dynamic segment",
		);
	});

	it("identical patterns → conflict (duplicate)", () => {
		const routes = [
			{ pattern: "/blog/[slug]", pageType: "blog" },
			{ pattern: "/blog/[slug]", pageType: "blog" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(false);
		expect(result.conflicts.length).toBe(1);
		expect(result.conflicts[0].reason).toContain("Duplicate");
	});

	it("/docs/[...slug] and /docs/[slug] → conflict (different dynamic names)", () => {
		const routes = [
			{ pattern: "/docs/[...slug]", pageType: "docs" },
			{ pattern: "/docs/[slug]", pageType: "docs" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(false);
	});

	it("/docs/[...slug] and /docs/getting-started/intro → conflict (rest matches deeper path)", () => {
		const routes = [
			{ pattern: "/docs/[...slug]", pageType: "docs_catchall" },
			{ pattern: "/docs/getting-started/intro", pageType: "docs_page" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(false);
		expect(result.conflicts.length).toBe(1);
		expect(result.conflicts[0].reason).toContain("Rest parameter");
	});

	it("/docs/[...slug] and /docs/getting-started → conflict (rest matches same-depth path)", () => {
		const routes = [
			{ pattern: "/docs/[...slug]", pageType: "docs_catchall" },
			{ pattern: "/docs/getting-started", pageType: "docs_page" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(false);
	});

	it("/docs/[...slug] and /blog/[...slug] → no conflict (different prefixes)", () => {
		const routes = [
			{ pattern: "/docs/[...slug]", pageType: "docs" },
			{ pattern: "/blog/[...slug]", pageType: "blog" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(true);
	});

	it("/docs/[...slug] and /about → no conflict (unrelated route)", () => {
		const routes = [
			{ pattern: "/docs/[...slug]", pageType: "docs" },
			{ pattern: "/about", pageType: "about" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(true);
	});

	it("static routes with different paths → no conflict", () => {
		const routes = [
			{ pattern: "/about", pageType: "about" },
			{ pattern: "/contact", pageType: "contact" },
		];

		const result = validateRoutePatterns(routes);
		expect(result.valid).toBe(true);
	});

	it("empty routes → valid", () => {
		expect(validateRoutePatterns([])).toEqual({
			valid: true,
			conflicts: [],
		});
	});
});

// ---------------------------------------------------------------------------
// validateRegistryCompleteness
// ---------------------------------------------------------------------------

describe("validateRegistryCompleteness", () => {
	const registry: Registry = {
		layouts: { default: { description: "D", page_types: ["landing"] } },
		collections: {
			blog: {
				source_pagetype: "blog",
				slug_field: "slug",
				listable_by: [],
			},
		},
		listings: {},
		static_pages: [{ pagetype: "landing", route: "/" }],
	};

	it("all covered → no missing", () => {
		const result = validateRegistryCompleteness(registry, ["landing", "blog"]);
		expect(result.missing).toEqual([]);
	});

	it("missing 'contact' → reported", () => {
		const result = validateRegistryCompleteness(registry, [
			"landing",
			"blog",
			"contact",
		]);
		expect(result.missing).toEqual(["contact"]);
	});
});

// ---------------------------------------------------------------------------
// validateContentModelRefs
// ---------------------------------------------------------------------------

describe("validateContentModelRefs", () => {
	const registry: Registry = {
		layouts: {},
		collections: {
			blog: {
				source_pagetype: "blog",
				slug_field: "slug",
				listable_by: ["blog_listing"],
			},
			tags: {
				source_pagetype: "tag",
				slug_field: "slug",
				listable_by: [],
			},
		},
		listings: {
			blog_listing: {
				route: "/blog",
				queries: [{ collection: "blog" }],
				paginated: false,
			},
		},
		static_pages: [],
	};

	it("all refs resolve → valid", () => {
		const cm: ContentModelOutput = {
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "slug",
					listable_by: ["blog_listing"],
				},
				tags: { source_pagetype: "tag", slug_field: "slug", listable_by: [] },
			},
		};

		const result = validateContentModelRefs(cm, registry);
		expect(result.valid).toBe(true);
	});

	it("orphan collection → reported", () => {
		const cm: ContentModelOutput = {
			collections: {
				blog: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
				orphan: {
					source_pagetype: "missing",
					slug_field: "slug",
					listable_by: [],
				},
			},
		};

		const result = validateContentModelRefs(cm, registry);
		expect(result.valid).toBe(false);
		expect(result.orphans.some((o) => o.includes("orphan"))).toBe(true);
	});

	it("broken listable_by → reported", () => {
		const cm: ContentModelOutput = {
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "slug",
					listable_by: ["nonexistent_listing"],
				},
			},
		};

		const result = validateContentModelRefs(cm, registry);
		expect(result.valid).toBe(false);
		expect(
			result.orphans.some(
				(o) => o.includes("nonexistent_listing") && o.includes("listing"),
			),
		).toBe(true);
	});

	it("listable_by with collection name instead of listing name → reported", () => {
		const cm: ContentModelOutput = {
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "slug",
					listable_by: ["tags"],
				},
			},
		};

		const result = validateContentModelRefs(cm, registry);
		expect(result.valid).toBe(false);
		expect(
			result.orphans.some((o) => o.includes("tags") && o.includes("listing")),
		).toBe(true);
	});

	it("listing with unknown collection → reported", () => {
		const cm: ContentModelOutput = {
			collections: {
				blog: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
			},
		};
		const reg: Registry = {
			layouts: {},
			collections: {
				blog: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
			},
			listings: {
				my_listing: {
					route: "/blog",
					queries: [{ collection: "nonexistent" }],
					paginated: false,
				},
			},
			static_pages: [],
		};
		const result = validateContentModelRefs(cm, reg);
		expect(result.valid).toBe(false);
		expect(result.orphans.some((o) => o.includes("nonexistent"))).toBe(true);
	});

	it("listing with unknown pagetype → reported", () => {
		const cm: ContentModelOutput = {
			collections: {
				blog: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
			},
		};
		const reg: Registry = {
			layouts: {},
			collections: {
				blog: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
			},
			listings: {
				my_listing: {
					route: "/blog",
					queries: [{ pagetype: "unknown_type" }],
					paginated: false,
				},
			},
			static_pages: [],
		};
		const result = validateContentModelRefs(cm, reg);
		expect(result.valid).toBe(false);
		expect(result.orphans.some((o) => o.includes("unknown_type"))).toBe(true);
	});
});
// ---------------------------------------------------------------------------
// validateComponentManifestRefs
// ---------------------------------------------------------------------------

describe("validateComponentManifestRefs", () => {
	const registry: Registry = {
		layouts: {},
		collections: {
			blog: {
				source_pagetype: "blog",
				slug_field: "slug",
				listable_by: [],
			},
		},
		listings: {},
		static_pages: [],
	};

	const cm: ContentModelOutput = {
		collections: {
			blog: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
		},
	};

	it("valid component refs → valid", () => {
		const manifest: ComponentManifestOutput = {
			components: {
				BlogCard: {
					file: "src/components/BlogCard.astro",
					collections: ["blog"],
				},
				Header: { file: "src/components/Header.astro", collections: [] },
			},
		};

		const result = validateComponentManifestRefs(manifest, registry, cm);
		expect(result.valid).toBe(true);
	});

	it("component references missing collection → reported", () => {
		const manifest: ComponentManifestOutput = {
			components: {
				Broken: {
					file: "src/components/Broken.astro",
					collections: ["nonexistent"],
				},
			},
		};

		const result = validateComponentManifestRefs(manifest, registry, cm);
		expect(result.valid).toBe(false);
		expect(result.orphans.some((o) => o.includes("nonexistent"))).toBe(true);
	});

	it("component references collection not in content model → reported", () => {
		const manifest: ComponentManifestOutput = {
			components: {
				Orphan: {
					file: "src/components/Orphan.astro",
					collections: ["extra"],
				},
			},
		};
		const reg: Registry = {
			...registry,
			collections: {
				...registry.collections,
				extra: {
					source_pagetype: "extra",
					slug_field: "slug",
					listable_by: [],
				},
			},
		};

		const result = validateComponentManifestRefs(manifest, reg, cm);
		expect(result.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildComponentManifestFromFiles
// ---------------------------------------------------------------------------

describe("buildComponentManifestFromFiles", () => {
	it("extracts collection references from component files", () => {
		const files: Record<string, string> = {
			"src/components/BlogCard.astro":
				'import { getCollection } from "astro:content";\nconst posts = await getCollection("blog");',
			"src/components/Header.astro": "<header>Site</header>",
		};

		const manifest = buildComponentManifestFromFiles(files);
		expect(manifest.components["src/components/BlogCard.astro"]).toBeDefined();
		expect(
			manifest.components["src/components/BlogCard.astro"].collections,
		).toEqual(["blog"]);
		// Components without getCollection calls are omitted
		expect(manifest.components["src/components/Header.astro"]).toBeUndefined();
	});

	it("deduplicates collection references in the same file", () => {
		const files: Record<string, string> = {
			"src/components/Multi.astro":
				'const a = await getCollection("blog");\nconst b = await getCollection("blog");',
		};

		const manifest = buildComponentManifestFromFiles(files);
		expect(
			manifest.components["src/components/Multi.astro"].collections,
		).toEqual(["blog"]);
	});

	it("handles single-quoted collection names", () => {
		const files: Record<string, string> = {
			"src/components/Tags.astro": "const tags = await getCollection('tags');",
		};

		const manifest = buildComponentManifestFromFiles(files);
		expect(
			manifest.components["src/components/Tags.astro"].collections,
		).toEqual(["tags"]);
	});

	it("handles empty input → empty manifest", () => {
		const manifest = buildComponentManifestFromFiles({});
		expect(Object.keys(manifest.components)).toEqual([]);
	});
});
