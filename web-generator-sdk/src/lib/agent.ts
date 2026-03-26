/**
 * Agent query wrapper.
 *
 * Wraps the claude-agent-sdk query() call with:
 * - Token usage tracking (per turn)
 * - Pluggable logger (interactive TUI or non-interactive verbose)
 *
 * Note: The SDK uses process.env, not the env option.
 * We set process.env from the resolved step env before calling query().
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage, SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PipelineLogger } from './logger.js';

const SYSTEM_PROMPT = `You are the Web Generator Orchestrator. Your role is to coordinate the generation of Astro.js projects from scraped website data.

## Key Constraints

- Follow the layout-first philosophy: HTML structure first, then content, then visual design
- Content is NEVER hardcoded - always read from src/data/content.json via src/lib/content.ts
- Use OKLCH color format for all design tokens
- Install Shadcn components with: npx shadcn add [component]

## Error Handling

If any step fails, log the error and retry up to 3 times before giving up.`;

export interface AgentQueryOptions {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  stepName: string;
  logger?: PipelineLogger;
}

export async function agentQuery(opts: AgentQueryOptions): Promise<string> {
  const { prompt, cwd, env, stepName, logger } = opts;

  // Set process.env from the resolved step env (SDK reads process.env, not the env option)
  const prevEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    prevEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    return await runQuery(prompt, cwd, stepName, logger);
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runQuery(
  prompt: string,
  cwd: string,
  stepName: string,
  logger?: PipelineLogger,
): Promise<string> {
  const startTime = Date.now();

  const result = query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'WebFetch'],
      cwd,
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let output = '';
  let turnCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  // If no logger provided, use a minimal internal one for non-interactive
  const log = logger || createFallbackLogger(stepName, startTime);

  for await (const message of result) {
    const msg = message as SDKMessage;

    if (msg.type === 'assistant') {
      turnCount++;
      const assistantMsg = message as SDKAssistantMessage;
      const usage = assistantMsg.message?.usage;
      if (usage) {
        totalInputTokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        totalOutputTokens += usage.output_tokens || 0;
      }
      log.updateTurn(turnCount, totalInputTokens, totalOutputTokens);

    } else if (msg.type === 'result') {
      const resultMsg = message as SDKResultMessage;
      if (resultMsg.subtype === 'success') {
        output = resultMsg.result;
        turnCount = resultMsg.num_turns || turnCount;
        totalCost = resultMsg.total_cost_usd || 0;
        if (totalInputTokens === 0 && resultMsg.usage) {
          totalInputTokens = resultMsg.usage.input_tokens || 0;
          totalOutputTokens = resultMsg.usage.output_tokens || 0;
        }
      } else {
        const errorMsg = (resultMsg as any).errors?.join('; ') || 'Unknown error';
        throw new Error(`${stepName} failed: ${errorMsg}`);
      }
    }
  }

  log.completeStep(totalCost);
  return output;
}

function createFallbackLogger(stepName: string, startTime: number): PipelineLogger {
  // Minimal logger when none is provided
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const hb = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  [heartbeat] ${stepName}: turn ${turns}, ${inputTokens} in / ${outputTokens} out, ${elapsed}s`);
  }, 30000);
  return {
    startStep: () => {},
    updateTurn(t, i, o) { turns = t; inputTokens = i; outputTokens = o; },
    completeStep: () => { clearInterval(hb); },
    failStep: (e) => { clearInterval(hb); console.error(`  [FAILED] ${stepName}: ${e}`); },
    skipStep: () => {},
    flush: () => {},
    destroy: () => { clearInterval(hb); },
  };
}

export function extractErrors(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split('\n')) {
    if (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
      errors.push(line.trim());
    }
  }
  return errors.slice(0, 10);
}
