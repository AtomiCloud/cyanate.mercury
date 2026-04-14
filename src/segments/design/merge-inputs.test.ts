import { describe, expect, it } from "bun:test";
import { buildMergePlan, validateMergePlan } from "./merge-inputs.js";

describe("buildMergePlan", () => {
	it("creates copy entries for analyze outputs", () => {
		const plan = buildMergePlan({ analyze: "/out/analyze" });

		const analyzeCopies = plan.copies.filter((c) => c.depId === "analyze");
		expect(analyzeCopies.length).toBeGreaterThan(0);
		expect(analyzeCopies.some((c) => c.to === "design-tokens.json")).toBe(true);
		expect(analyzeCopies.some((c) => c.to === "style-fingerprint.json")).toBe(
			true,
		);
		expect(analyzeCopies.some((c) => c.to === "component-recipes.json")).toBe(
			true,
		);
		expect(analyzeCopies.some((c) => c.to === "patterns")).toBe(true);
	});

	it("creates copy entries for wireframe outputs", () => {
		const plan = buildMergePlan({ wireframe: "/out/wireframe" });

		const wireframeCopies = plan.copies.filter((c) => c.depId === "wireframe");
		expect(wireframeCopies.length).toBeGreaterThan(0);
		expect(wireframeCopies.some((c) => c.to === "project")).toBe(true);
		expect(
			wireframeCopies.some((c) => c.to === "component-manifest.json"),
		).toBe(true);
	});

	it("handles both dependencies", () => {
		const plan = buildMergePlan({
			analyze: "/out/analyze",
			wireframe: "/out/wireframe",
		});

		expect(plan.copies.some((c) => c.depId === "analyze")).toBe(true);
		expect(plan.copies.some((c) => c.depId === "wireframe")).toBe(true);
	});

	it("returns empty errors when deps provided", () => {
		const plan = buildMergePlan({ analyze: "/out/analyze" });
		expect(plan.errors).toEqual([]);
	});
});

describe("validateMergePlan", () => {
	it("returns valid when all expected files are in plan", () => {
		const plan = buildMergePlan({
			analyze: "/out/analyze",
			wireframe: "/out/wireframe",
		});

		const result = validateMergePlan(
			plan,
			[
				"design-tokens.json",
				"style-fingerprint.json",
				"component-recipes.json",
			],
			["project", "component-manifest.json"],
		);

		expect(result.valid).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("reports missing analyze files", () => {
		const plan = buildMergePlan({ wireframe: "/out/wireframe" });

		const result = validateMergePlan(plan, ["design-tokens.json"], []);

		expect(result.valid).toBe(false);
		expect(result.missing).toContain("analyze:design-tokens.json");
	});

	it("reports missing wireframe files", () => {
		const plan = buildMergePlan({ analyze: "/out/analyze" });

		const result = validateMergePlan(plan, [], ["project"]);

		expect(result.valid).toBe(false);
		expect(result.missing).toContain("wireframe:project");
	});
});
