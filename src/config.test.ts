import { describe, expect, test } from "bun:test";
import { CuiConfigSchema } from "./config.js";

describe("Config Schema", () => {
	const minimalConfig = {
		input: "/tmp/input",
		defaults: {
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		},
		heartbeat: { timeout: 900_000, interval: 30_000 },
		logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
	};

	test("config with all new fields → valid", () => {
		const config = {
			...minimalConfig,
			providers: {
				opus: { provider: "anthropic", model: "claude-opus-4-20250514" },
				sonnet: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			},
			reviewer_matrix: {
				"review.layout": {
					providers: ["opus", "sonnet"],
					aggregation: "any_reject",
				},
			},
			step_matrix: {
				"analyze.style": "opus",
			},
		};
		const result = CuiConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
	});

	test("config without new fields → valid (backwards compat)", () => {
		const result = CuiConfigSchema.safeParse(minimalConfig);
		expect(result.success).toBe(true);
	});

	test("invalid reviewer_matrix shape → error", () => {
		const config = {
			...minimalConfig,
			reviewer_matrix: {
				"review.layout": {
					providers: "not-an-array",
					aggregation: "any_reject",
				},
			},
		};
		const result = CuiConfigSchema.safeParse(config);
		expect(result.success).toBe(false);
	});

	test("reviewer_matrix with empty providers → error", () => {
		const config = {
			...minimalConfig,
			reviewer_matrix: {
				"review.layout": {
					providers: [],
					aggregation: "any_reject",
				},
			},
		};
		const result = CuiConfigSchema.safeParse(config);
		expect(result.success).toBe(false);
	});

	test("invalid aggregation value → error", () => {
		const config = {
			...minimalConfig,
			reviewer_matrix: {
				"review.layout": {
					providers: ["opus"],
					aggregation: "all_pass",
				},
			},
		};
		const result = CuiConfigSchema.safeParse(config);
		expect(result.success).toBe(false);
	});

	test("step_matrix with string values → valid", () => {
		const config = {
			...minimalConfig,
			step_matrix: {
				"step.a": "provider-key",
			},
		};
		const result = CuiConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
	});

	test("step_matrix with unknown provider reference → valid (validated at runtime, not schema-level)", () => {
		// step_matrix can reference any string key — schema-level validation
		// does not check whether the referenced provider actually exists.
		// Runtime code (resolveProviders in multi-provider.ts) is responsible
		// for validating that referenced providers are defined.
		const config = {
			...minimalConfig,
			providers: {
				// defined providers: only "sonnet"
				sonnet: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			},
			step_matrix: {
				// "unknown-opus" is not in providers — schema accepts it, runtime rejects
				"analyze.style": "unknown-opus",
			},
		};
		const result = CuiConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		// Confirm the unknown reference is preserved in the parsed result
		expect(result.data?.step_matrix?.["analyze.style"]).toBe("unknown-opus");
	});
});
