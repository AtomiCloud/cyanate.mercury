/**
 * cui.yaml config loader with Zod validation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CuiConfig } from "./engine/types.js";

const LLMProfileSchema = z.object({
	provider: z.string().default("anthropic"),
	model: z.string(),
	maxTurns: z.number().optional(),
	env: z.record(z.string(), z.string()).optional(),
});

const HeartbeatSchema = z
	.object({
		timeout: z.number().default(900_000),
		interval: z.number().default(30_000),
	})
	.default({ timeout: 900_000, interval: 30_000 });

const LoggingSchema = z
	.object({
		eventsFile: z.string().default("agent-events.jsonl"),
		debugFile: z.string().default("agent-debug.log"),
	})
	.default({ eventsFile: "agent-events.jsonl", debugFile: "agent-debug.log" });

const CuiConfigSchema = z.object({
	input: z.string(),
	reference: z.string().optional(),
	defaults: LLMProfileSchema.default({
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
	}),
	profiles: z
		.record(
			z.string(),
			z.object({
				provider: z.string().optional(),
				model: z.string().optional(),
				maxTurns: z.number().optional(),
				env: z.record(z.string(), z.string()).optional(),
			}),
		)
		.default({}),
	heartbeat: HeartbeatSchema,
	logging: LoggingSchema,
});

export function loadConfig(configPath: string): CuiConfig {
	const absPath = resolve(configPath);
	let raw: string;

	try {
		raw = readFileSync(absPath, "utf-8");
	} catch {
		throw new Error(`Cannot read config at ${absPath}`);
	}

	let parsed: unknown;
	if (absPath.endsWith(".yaml") || absPath.endsWith(".yml")) {
		parsed = parseYaml(raw);
	} else {
		parsed = JSON.parse(raw);
	}

	const result = CuiConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`Invalid config at ${absPath}:\n${issues}`);
	}

	return result.data as CuiConfig;
}
