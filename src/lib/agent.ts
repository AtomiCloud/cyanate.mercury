/**
 * Agent query wrapper.
 *
 * Wraps the claude-agent-sdk query() call with:
 * - LLM profile injection (model/provider via env vars)
 * - Configurable heartbeat timeout (from cui.yaml)
 * - Token usage tracking with enhanced event logging
 * - Logger integration
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKToolProgressMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CuiConfig, LLMProfile } from "../engine/types.js";
import type { PipelineLogger } from "./logger.js";

const DEFAULT_HEARTBEAT_TIMEOUT = 900_000; // 15 min
const DEFAULT_HEARTBEAT_INTERVAL = 30_000; // 30s

/** Frozen snapshot of process.env at module load time. */
const frozenProcessEnv: Record<string, string | undefined> = { ...process.env };

export interface AgentQueryOptions {
	prompt: string;
	systemPrompt?: string;
	cwd: string;
	profile: LLMProfile;
	stepName: string;
	logger?: PipelineLogger;
	maxTurns?: number;
	tools?: string[];
	/** Pipeline config — used for heartbeat/logging settings */
	config?: CuiConfig;
}

function profileToEnv(profile: LLMProfile): Record<string, string> {
	const env: Record<string, string> = {};
	if (profile.model) env.ANTHROPIC_MODEL = profile.model;
	if (profile.env) Object.assign(env, profile.env);
	return env;
}

const DEFAULT_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"Skill",
	"WebFetch",
];

/** Mutable counters passed through the message stream processor. */
interface StreamState {
	output: string;
	turnCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	lastHeartbeatAt: number;
	startTime: number;
}

export interface AgentQueryResult {
	output: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

export async function agentQuery(opts: AgentQueryOptions): Promise<string> {
	const result = await agentQueryWithMetrics(opts);
	return result.output;
}

export async function agentQueryWithMetrics(
	opts: AgentQueryOptions,
): Promise<AgentQueryResult> {
	const {
		prompt,
		systemPrompt,
		cwd,
		profile,
		stepName,
		logger,
		maxTurns,
		tools,
		config,
	} = opts;
	const startTime = Date.now();
	const timeoutMs = config?.heartbeat?.timeout ?? DEFAULT_HEARTBEAT_TIMEOUT;
	const intervalMs = config?.heartbeat?.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
	const eventsFile = config?.logging?.eventsFile ?? "agent-events.jsonl";

	const result = query({
		prompt,
		options: {
			systemPrompt,
			tools: tools ?? DEFAULT_TOOLS,
			cwd,
			settingSources: ["local"],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns: maxTurns ?? profile.maxTurns,
			env: { ...frozenProcessEnv, ...profileToEnv(profile) },
		},
	});

	const log = logger || createFallbackLogger(stepName, startTime, intervalMs);
	const eventLog = join(cwd, eventsFile);
	const logEvent = (event: Record<string, unknown>) => {
		appendFile(
			eventLog,
			`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`,
			"utf-8",
		).catch(() => {});
	};

	const state: StreamState = {
		output: "",
		turnCount: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCost: 0,
		lastHeartbeatAt: Date.now(),
		startTime,
	};

	const iterator = result[Symbol.asyncIterator]();

	try {
		await consumeStream(iterator, state, stepName, timeoutMs, log, logEvent);
		log.completeStep(state.totalCost);
		return {
			output: state.output,
			turns: state.turnCount,
			inputTokens: state.totalInputTokens,
			outputTokens: state.totalOutputTokens,
			cost: state.totalCost,
		};
	} finally {
		await iterator.return?.();
	}
}

async function consumeStream(
	iterator: AsyncIterator<SDKMessage>,
	state: StreamState,
	stepName: string,
	timeoutMs: number,
	log: PipelineLogger,
	logEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
	while (true) {
		const next = await nextWithTimeout(
			iterator,
			state,
			stepName,
			timeoutMs,
			logEvent,
		);
		if (next.done) break;
		processMessage(next.value as SDKMessage, state, stepName, log, logEvent);
	}
}

function processMessage(
	msg: SDKMessage,
	state: StreamState,
	stepName: string,
	log: PipelineLogger,
	logEvent: (event: Record<string, unknown>) => void,
): void {
	if (msg.type === "assistant") {
		handleAssistant(msg as SDKAssistantMessage, state, log, logEvent);
	} else if (msg.type === "tool_progress") {
		handleToolProgress(
			msg as unknown as SDKToolProgressMessage,
			state,
			logEvent,
		);
	} else if (msg.type === "result") {
		handleResult(msg as SDKResultMessage, state, stepName);
	}
}

function handleAssistant(
	msg: SDKAssistantMessage,
	state: StreamState,
	log: PipelineLogger,
	logEvent: (event: Record<string, unknown>) => void,
): void {
	state.turnCount++;
	const usage = msg.message?.usage;
	if (usage) {
		state.totalInputTokens +=
			(usage.input_tokens || 0) +
			(usage.cache_read_input_tokens || 0) +
			(usage.cache_creation_input_tokens || 0);
		state.totalOutputTokens += usage.output_tokens || 0;
	}

	// Extract tool names from content blocks
	const tools: string[] = [];
	const content = msg.message?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "tool_use" &&
				"name" in block
			) {
				tools.push(String(block.name));
			}
		}
	}

	logEvent({
		type: "turn",
		turn: state.turnCount,
		tools,
		inputTokens: state.totalInputTokens,
		outputTokens: state.totalOutputTokens,
		elapsed: Math.round((Date.now() - state.startTime) / 1000),
	});

	log.updateTurn(
		state.turnCount,
		state.totalInputTokens,
		state.totalOutputTokens,
	);
	state.lastHeartbeatAt = Date.now();
}

function handleToolProgress(
	msg: SDKToolProgressMessage,
	state: StreamState,
	logEvent: (event: Record<string, unknown>) => void,
): void {
	logEvent({
		type: "tool_progress",
		tool: msg.tool_name,
		elapsed: msg.elapsed_time_seconds,
	});
	state.lastHeartbeatAt = Date.now();
}

function handleResult(
	msg: SDKResultMessage,
	state: StreamState,
	stepName: string,
): void {
	if (msg.subtype === "success") {
		state.output = msg.result;
		state.turnCount = msg.num_turns || state.turnCount;
		state.totalCost = msg.total_cost_usd || 0;
		state.lastHeartbeatAt = Date.now();
		return;
	}

	const errorMsg = Array.isArray((msg as Record<string, unknown>).errors)
		? ((msg as Record<string, unknown>).errors as string[]).join("; ")
		: (msg as Record<string, unknown>).result ||
			`Unknown error (subtype: ${String(msg.subtype)})`;
	throw new Error(`${stepName} failed: ${errorMsg}`);
}

async function nextWithTimeout(
	iterator: AsyncIterator<SDKMessage>,
	state: StreamState,
	stepName: string,
	timeoutMs: number,
	logEvent: (event: Record<string, unknown>) => void,
): Promise<IteratorResult<SDKMessage>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			iterator.next(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const idleMs = Date.now() - state.lastHeartbeatAt;
					logEvent({
						type: "timeout",
						step: stepName,
						idleMs,
						timeoutMs,
					});
					reject(
						new Error(
							`${stepName} timed out: no heartbeat for ${formatDuration(idleMs)}`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function createFallbackLogger(
	stepName: string,
	startTime: number,
	intervalMs: number,
): PipelineLogger {
	let turns = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	const hb = setInterval(() => {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
		console.log(
			`  [heartbeat] ${stepName}: turn ${turns}, ${inputTokens} in / ${outputTokens} out, ${elapsed}s`,
		);
	}, intervalMs);
	return {
		startStep() {},
		updateTurn(t, i, o) {
			turns = t;
			inputTokens = i;
			outputTokens = o;
		},
		completeStep() {
			clearInterval(hb);
		},
		failStep(e) {
			clearInterval(hb);
			console.error(`  [FAILED] ${stepName}: ${e}`);
		},
		skipStep() {},
		startSegment() {},
		finishSegment() {
			return {
				steps: 0,
				turns: 0,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
				duration: 0,
			};
		},
		flush() {},
		destroy() {
			clearInterval(hb);
		},
	};
}

export function extractErrors(output: string): string[] {
	const errors: string[] = [];
	for (const line of output.split("\n")) {
		if (
			line.toLowerCase().includes("error") ||
			line.toLowerCase().includes("failed")
		) {
			errors.push(line.trim());
		}
	}
	return errors.slice(0, 10);
}
