import { describe, expect, it } from "bun:test";
import {
	checkLayerIsolation,
	findLayerViolations,
	findUnlayeredProperties,
	validateLayerOrder,
} from "./layers.js";

describe("validateLayerOrder", () => {
	it("returns valid for correct order", () => {
		const content = `@layer reset, tokens, layout, typography, surfaces, color, motion, components;`;
		const expected = [
			"reset",
			"tokens",
			"layout",
			"typography",
			"surfaces",
			"color",
			"motion",
			"components",
		];

		const result = validateLayerOrder(content, expected);
		expect(result.valid).toBe(true);
	});

	it("returns invalid for swapped order", () => {
		const content = `@layer reset, color, layout, typography, surfaces, tokens, motion, components;`;
		const expected = [
			"reset",
			"tokens",
			"layout",
			"typography",
			"surfaces",
			"color",
			"motion",
			"components",
		];

		const result = validateLayerOrder(content, expected);
		expect(result.valid).toBe(false);
		expect(result.actual).not.toEqual(result.expected);
	});

	it("handles empty content", () => {
		const result = validateLayerOrder("", ["reset", "tokens"]);
		expect(result.valid).toBe(false);
	});
});

describe("findLayerViolations", () => {
	it("returns empty for CSS inside owned layer", () => {
		const content = `@layer layout {
				.container {
					display: grid;
					gap: var(--spacing-md);
				}
			}`;

		const violations = findLayerViolations(content, "layout", [
			"reset",
			"layout",
			"typography",
		]);
		expect(violations).toEqual([]);
	});

	it("detects nested foreign layer inside owned layer", () => {
		const content = `@layer layout {
				.container {
					display: grid;
				}
				@layer color {
					background: var(--color-primary);
				}
			}`;

		const violations = findLayerViolations(content, "layout", [
			"layout",
			"color",
		]);
		// The @layer color inside layout is a nested cross-layer reference
		expect(violations.length).toBeGreaterThan(0);
	});

	it("allows sibling layers by default (cumulative CSS from previous phases)", () => {
		const content = `@layer layout {
				.container { display: grid; }
			}
			@layer typography {
				body { font-size: 1rem; }
			}`;

		const violations = findLayerViolations(content, "layout", [
			"layout",
			"typography",
			"color",
		]);
		// Sibling layers are NOT violations by default
		expect(violations).toEqual([]);
	});

	it("returns empty for missing layer block", () => {
		const content = `.global { color: red; }`;
		const violations = findLayerViolations(content, "layout", [
			"layout",
			"color",
		]);
		expect(violations).toEqual([]);
	});

	it("flags top-level sibling layers when checkSiblingLayers is true", () => {
		const content = `@layer typography {
				body { font-size: 1rem; }
			}
			@layer color {
				:root { --color-primary: oklch(0.7 0.15 250); }
			}`;

		const violations = findLayerViolations(
			content,
			"typography",
			["typography", "color"],
			true,
		);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0].layer).toBe("color");
	});

	it("does not flag top-level sibling layers when checkSiblingLayers is false", () => {
		const content = `@layer typography {
				body { font-size: 1rem; }
			}
			@layer color {
				:root { --color-primary: oklch(0.7 0.15 250); }
			}`;

		const violations = findLayerViolations(
			content,
			"typography",
			["typography", "color"],
			false,
		);
		expect(violations).toEqual([]);
	});
});

describe("checkLayerIsolation", () => {
	it("passes when file only contains owned @layer layout", () => {
		const files: Record<string, string> = {
			"globals.css": `@layer layout {
					.container { display: grid; }
				}`,
		};

		const result = checkLayerIsolation(files, "layout", [
			"layout",
			"typography",
			"color",
		]);
		expect(result.isolated).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("allows sibling layers from previous phases by default (cumulative CSS)", () => {
		const files: Record<string, string> = {
			"globals.css": `@layer layout {
					.container { display: grid; }
				}
				@layer typography {
					body { font-size: 1rem; }
				}`,
		};

		const result = checkLayerIsolation(files, "layout", [
			"layout",
			"typography",
			"color",
		]);
		// Sibling layers are NOT violations by default
		expect(result.isolated).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("flags sibling layers when checkSiblingLayers option is set", () => {
		const files: Record<string, string> = {
			"globals.css": `@layer typography {
					body { font-size: 1rem; }
				}
				@layer color {
					:root { --color-primary: oklch(0.7 0.15 250); }
				}`,
		};

		const result = checkLayerIsolation(
			files,
			"typography",
			["typography", "color"],
			{ checkSiblingLayers: true },
		);
		expect(result.isolated).toBe(false);
		expect(result.violations.length).toBeGreaterThan(0);
		expect(result.violations[0].file).toBe("globals.css");
		expect(result.violations[0].layer).toBe("color");
	});

	it("detects nested foreign layer as violation", () => {
		const files: Record<string, string> = {
			"globals.css": `@layer layout {
					@layer color {
						.button { background: var(--color-primary); }
					}
				}`,
		};

		const result = checkLayerIsolation(files, "layout", ["layout", "color"]);
		expect(result.isolated).toBe(false);
		expect(result.violations.length).toBeGreaterThan(0);
		expect(result.violations[0].file).toBe("globals.css");
	});

	it("skips .astro and .ts files", () => {
		const files: Record<string, string> = {
			"Layout.astro": `---
	const x = 1;
	---`,
			"button.ts": `export const x = 1;`,
		};

		const result = checkLayerIsolation(files, "layout", ["layout", "color"]);
		expect(result.isolated).toBe(true);
	});

	it("skips .css files without layer blocks", () => {
		const files: Record<string, string> = {
			"no-layers.css": `.no-layer { color: red; }`,
		};

		const result = checkLayerIsolation(files, "layout", ["layout", "color"]);
		expect(result.isolated).toBe(true);
	});

	it("final QA: cumulative multi-layer file passes for all layer checks", () => {
		const files: Record<string, string> = {
			"globals.css": `@layer layout {
					.container { display: grid; }
				}
				@layer typography {
					body { font-size: 1rem; }
				}
				@layer color {
					:root { --color-primary: oklch(0.7 0.15 250); }
				}
				@layer motion {
					* { transition: all 0.2s; }
				}`,
		};

		const allLayers = [
			"reset",
			"tokens",
			"layout",
			"typography",
			"color",
			"motion",
			"components",
		];

		// Each layer check should pass — no nested foreign layers, sibling check off
		for (const layer of allLayers) {
			const result = checkLayerIsolation(files, layer, allLayers);
			expect(result.isolated).toBe(true);
		}
	});
});

describe("findUnlayeredProperties", () => {
	it("allows CSS custom properties in :root", () => {
		const content = `:root {
				--color-primary: oklch(0.7 0.15 250);
				--spacing-sm: 0.5rem;
			}`;

		const unlayered = findUnlayeredProperties(content);
		expect(unlayered.length).toBe(0);
	});

	it("allows @keyframes outside layers", () => {
		const content = `@keyframes fade {
				from { opacity: 0; }
				to { opacity: 1; }
			}`;

		const unlayered = findUnlayeredProperties(content);
		expect(unlayered.length).toBe(0);
	});

	it("allows @media outside layers", () => {
		const content = `@media (prefers-reduced-motion: reduce) {
				* { transition: none; }
			}`;

		const unlayered = findUnlayeredProperties(content);
		expect(unlayered.length).toBe(0);
	});

	it("flags plain property declarations outside layers", () => {
		const content = `.button {
				background: var(--color-primary);
				transition: all 0.2s;
			}`;

		const unlayered = findUnlayeredProperties(content);
		expect(unlayered.length).toBeGreaterThan(0);
	});
});
