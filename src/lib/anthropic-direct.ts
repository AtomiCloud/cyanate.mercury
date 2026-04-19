/**
 * Direct HTTP client for Anthropic-compatible Messages endpoints.
 *
 * Used for one-shot classification calls where the agent SDK's subprocess +
 * session machinery is pure overhead. Reads model from the LLM profile,
 * base URL from profile.env.ANTHROPIC_BASE_URL, and API key from the
 * ANTHROPIC_API_KEY env var (falling back to empty — local proxies usually
 * ignore it).
 */

import type { LLMProfile } from "../engine/types.js";

export interface DirectCallOpts {
	profile: LLMProfile;
	system?: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	/** Abort signal for caller-side cancellation. */
	signal?: AbortSignal;
}

export interface DirectCallResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

interface MessagesResponse {
	content?: Array<{ type: string; text?: string }>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

const DEFAULT_MAX_TOKENS = 8192;

export function resolveBaseUrl(profile: LLMProfile): string {
	const raw =
		profile.env?.ANTHROPIC_BASE_URL ??
		process.env.ANTHROPIC_BASE_URL ??
		"https://api.anthropic.com";
	return raw.replace(/\/+$/, "");
}

function resolveApiKey(): string {
	return process.env.ANTHROPIC_API_KEY ?? "";
}

function extractText(body: MessagesResponse): string {
	const blocks = body.content ?? [];
	return blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

function sumInputTokens(usage: MessagesResponse["usage"]): number {
	if (!usage) return 0;
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0)
	);
}

export async function callMessages(
	opts: DirectCallOpts,
): Promise<DirectCallResult> {
	const baseUrl = resolveBaseUrl(opts.profile);
	const apiKey = resolveApiKey();

	const body: Record<string, unknown> = {
		model: opts.profile.model,
		max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: opts.user }],
	};
	if (opts.system) body.system = opts.system;
	if (typeof opts.temperature === "number") body.temperature = opts.temperature;

	const res = await fetch(`${baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
		signal: opts.signal,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`anthropic-direct ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
		);
	}

	const json = (await res.json()) as MessagesResponse;
	return {
		text: extractText(json),
		inputTokens: sumInputTokens(json.usage),
		outputTokens: json.usage?.output_tokens ?? 0,
	};
}
