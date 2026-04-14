import { describe, expect, it } from "bun:test";
import type { DesignTokensV2 } from "../../types.js";
import {
	applyContrastFixes,
	autoFixContrast,
	checkContrast,
	findContrastViolations,
	generateColorSystem,
} from "./color.js";

describe("generateColorSystem", () => {
	it("produces light and dark maps using template source var names", () => {
		const colors: DesignTokensV2["atomic"]["colors"] = {
			primary: "oklch(0.7 0.15 250)",
			foreground: "oklch(0.15 0.02 240)",
			background: "oklch(0.98 0.01 240)",
		};
		const visualIdentity: DesignTokensV2["visualIdentity"] = {
			colorDistribution: { dominant: {}, secondary: {}, accent: {} },
			borders: {},
		};

		const result = generateColorSystem(colors, visualIdentity);

		// Source vars use template names (--primary, --foreground, etc.)
		// NOT --color-primary, because @theme inline maps --color-primary: var(--primary)
		expect(result.light["--primary"]).toBe("oklch(0.7 0.15 250)");
		expect(result.dark["--primary"]).toBeDefined();
		// Dark mode should have different lightness
		const lightPrimary = result.light["--primary"];
		const darkPrimary = result.dark["--primary"];
		if (lightPrimary && darkPrimary) {
			const lightL = parseFloat(
				lightPrimary.match(/oklch\(([\d.]+)/)?.[1] ?? "0",
			);
			const darkL = parseFloat(
				darkPrimary.match(/oklch\(([\d.]+)/)?.[1] ?? "0",
			);
			expect(darkL).not.toBe(lightL);
		}
	});

	it("handles empty color tokens", () => {
		const result = generateColorSystem(
			{},
			{
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		);
		expect(result.light).toEqual({});
		expect(result.dark).toEqual({});
	});
});

describe("checkContrast", () => {
	it("black on white gives ~21:1 ratio", () => {
		// Black = oklch(0 0 0), white = oklch(1 0 0)
		const result = checkContrast("oklch(0 0 0)", "oklch(1 0 0)");
		expect(result.ratio).toBeGreaterThan(20);
		expect(result.passesAA).toBe(true);
		expect(result.passesAALarge).toBe(true);
	});

	it("light gray on white gives low ratio and fails AA", () => {
		// Very light gray has low relative luminance
		const result = checkContrast("oklch(0.95 0.01 240)", "oklch(1 0 0)");
		expect(result.ratio).toBeLessThan(3);
		expect(result.passesAA).toBe(false);
	});

	it("returns false for unparseable colors", () => {
		const result = checkContrast("not-a-color", "oklch(1 0 0)");
		expect(result.passesAA).toBe(false);
		expect(result.ratio).toBe(1);
	});

	it("handles hex colors", () => {
		const result = checkContrast("#000000", "#ffffff");
		expect(result.ratio).toBeGreaterThan(20);
		expect(result.passesAA).toBe(true);
	});

	it("handles rgb colors", () => {
		const result = checkContrast("rgb(0, 0, 0)", "rgb(255, 255, 255)");
		expect(result.ratio).toBeGreaterThan(20);
		expect(result.passesAA).toBe(true);
	});

	it("computes correct ratio for hex mid-gray on white (#777 vs #fff)", () => {
		// WCAG standard: #777777 on #ffffff should be ~4.48:1
		const result = checkContrast("#777777", "#ffffff");
		expect(result.ratio).toBeGreaterThan(4);
		expect(result.ratio).toBeLessThan(5);
	});
});

describe("findContrastViolations", () => {
	it("identifies failing pairs with context", () => {
		const pairs = [
			{
				foreground: "oklch(0.9 0.01 240)",
				background: "oklch(1 0 0)",
				context: "foreground:muted on background:background",
			},
		];

		const violations = findContrastViolations(pairs);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0].context).toContain("muted");
	});

	it("returns empty for passing pairs", () => {
		const pairs = [
			{
				foreground: "oklch(0.15 0.02 240)",
				background: "oklch(0.98 0.01 240)",
				context: "foreground:foreground on background:background",
			},
		];

		const violations = findContrastViolations(pairs);
		expect(violations.length).toBe(0);
	});
});

describe("autoFixContrast", () => {
	it("returns original if already passing", () => {
		const result = autoFixContrast(
			"oklch(0.15 0.02 240)",
			"oklch(0.98 0.01 240)",
			4.5,
		);
		expect(result.adjustment).toBe(0);
		expect(result.fixed).toBe("oklch(0.15 0.02 240)");
	});

	it("adjusts lightness to meet target ratio", () => {
		// Light foreground on white background - need to darken
		const result = autoFixContrast(
			"oklch(0.9 0.05 250)",
			"oklch(0.98 0.01 240)",
			4.5,
		);

		expect(result.adjustment).not.toBe(0);
		// New color should have lower lightness
		const newL = parseFloat(result.fixed.match(/oklch\(([\d.]+)/)?.[1] ?? "0");
		expect(newL).toBeLessThan(0.9);
	});

	it("preserves hue and chroma when adjusting", () => {
		const result = autoFixContrast(
			"oklch(0.85 0.12 250)",
			"oklch(0.98 0.01 240)",
			4.5,
		);

		// Extract C and H from fixed color
		const fixed = result.fixed;
		const original = "oklch(0.85 0.12 250)";

		const fixedC = parseFloat(
			fixed.match(/oklch\([\d.]+\s+([\d.]+)/)?.[1] ?? "0",
		);
		const fixedH = parseFloat(
			fixed.match(/oklch\([\d.]+\s+[\d.]+\s+([\d.]+)/)?.[1] ?? "0",
		);
		const origC = parseFloat(
			original.match(/oklch\([\d.]+\s+([\d.]+)/)?.[1] ?? "0",
		);
		const origH = parseFloat(
			original.match(/oklch\([\d.]+\s+[\d.]+\s+([\d.]+)/)?.[1] ?? "0",
		);

		expect(fixedC).toBeCloseTo(origC, 2);
		expect(fixedH).toBeCloseTo(origH, 1);
	});
});

describe("applyContrastFixes", () => {
	it("applies fixes and produces changelog", () => {
		const colorSystem = {
			light: {
				"--foreground": "oklch(0.9 0.01 240)",
				"--background": "oklch(0.98 0.01 240)",
			},
			dark: {
				"--foreground": "oklch(0.1 0.02 240)",
				"--background": "oklch(0.02 0.01 240)",
			},
		};

		const violations = [
			{
				context: "foreground:foreground on background:background",
				ratio: 1.5,
				required: 4.5,
			},
		];

		const result = applyContrastFixes(colorSystem, violations);
		expect(result.changes.length).toBeGreaterThan(0);
		expect(result.fixed.light["--foreground"]).toBeDefined();
	});

	it("applies mode-tagged violations to the correct map only", () => {
		const colorSystem = {
			light: {
				"--foreground": "oklch(0.9 0.01 240)",
				"--background": "oklch(0.98 0.01 240)",
			},
			dark: {
				"--foreground": "oklch(0.1 0.02 240)",
				"--background": "oklch(0.02 0.01 240)",
			},
		};

		// Only light mode has a violation
		const violations = [
			{
				context: "light:foreground:foreground on background:background",
				ratio: 1.5,
				required: 4.5,
			},
		];

		const result = applyContrastFixes(colorSystem, violations);
		// Light should be fixed
		expect(result.changes.length).toBeGreaterThan(0);
		expect(result.changes[0]).toContain("Light:");
		expect(result.fixed.light["--foreground"]).not.toBe(
			colorSystem.light["--foreground"],
		);
		// Dark should be untouched (passes already)
		expect(result.fixed.dark["--foreground"]).toBe(
			colorSystem.dark["--foreground"],
		);
	});
});
