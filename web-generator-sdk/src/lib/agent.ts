/**
 * Agent query wrapper.
 *
 * Wraps the claude-agent-sdk query() call with:
 * - Token usage tracking (per turn)
 * - Pluggable logger (interactive TUI or non-interactive verbose)
 *
 * Note: Env vars are passed through the SDK's env option to avoid race conditions
 * when multiple agents run concurrently.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage, SDKAssistantMessage, SDKMessage, SDKToolProgressMessage, SDKToolUseSummaryMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'fs/promises';
import { join } from 'path';
import type { PipelineLogger } from './logger.js';

/** Frozen snapshot of process.env at module load time.
 *  Avoids race conditions when multiple agents read process.env concurrently. */
const frozenProcessEnv: Record<string, string | undefined> = { ...process.env };

const SYSTEM_PROMPT = `You are the Web Generator Orchestrator v2. Your role is to coordinate the phased generation of Astro.js projects from scraped website data.

## Pipeline Architecture v2

The pipeline has 7 independent phases, each with its own validator:
- Phase 0: ANALYZE — style fingerprint, 7-layer design tokens, component recipes
- Phase 1: STRUCTURE — reduce, classify, seed (content collections)
- Phase 2: LAYOUT — grid/flex/spacing (gray-box, no color/typography)
- Phase 3: DESIGN — typography/components/surfaces (neutral grays only)
- Phase 4: COLOR — color system, light+dark theme, WCAG contrast
- Phase 5: MOTION — transitions, hover/focus states, scroll reveals, reduced-motion
- Phase 6: POLISH — final validation, quality scoring, style fingerprint fidelity

## Key Principles

1. **Layered independence** — Each phase touches different CSS/HTML properties. Layout (Phase 2) never regresses when Color (Phase 4) runs.
2. **Structured handoffs** — Data passes between phases as JSON files in scratch/ directory, never as truncated strings.
3. **Style-aware generation** — The style fingerprint drives all decisions: density, formality, motion, depth.
4. **Content collections** — Multi-instance pages use Astro content collections with [slug] routing, not flat content.json queries.
5. **OKLCH colors** — All color values use OKLCH format.
6. **Shadcn components** — Install with: npx shadcn add [component]

## Phase Constraints

When you receive a prompt specifying a phase, you MUST:
- Only modify the files and CSS properties that phase owns
- Read the style-fingerprint.json and design-tokens.json from the scratch directory
- Follow the component-recipes.json for component styling
- Run validation (typecheck, astro check, build) before reporting success

## Error Handling

If any step fails, log the error and retry up to 3 times before giving up.`;

export interface AgentQueryOptions {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  stepName: string;
  logger?: PipelineLogger;
  maxTurns?: number;
}

export async function agentQuery(opts: AgentQueryOptions): Promise<string> {
  const { prompt, cwd, env, stepName, logger, maxTurns } = opts;

  // Pass env through the SDK's env option instead of mutating process.env.
  // This avoids race conditions when multiple agents run concurrently.
  return await runQuery(prompt, cwd, stepName, logger, env, maxTurns);
}

async function runQuery(
  prompt: string,
  cwd: string,
  stepName: string,
  logger?: PipelineLogger,
  env?: Record<string, string>,
  maxTurns?: number,
): Promise<string> {
  const startTime = Date.now();

  const result = query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'WebFetch'],
      cwd,
      settingSources: ['local'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns,
      env: env ? { ...frozenProcessEnv, ...env } : undefined,
      debugFile: join(cwd, 'agent-debug.log'),
    },
  });

  let output = '';
  let turnCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  const eventLog = join(cwd, 'agent-events.jsonl');
  const logEvent = (event: Record<string, unknown>) => {
    appendFile(eventLog, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n', 'utf-8').catch(() => {});
  };

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

      // Extract tool calls from the assistant message content
      const content = assistantMsg.message?.content;
      const tools: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const tb = block as { name?: string; input?: Record<string, unknown> };
            const snippet = tb.name === 'Bash'
              ? (tb.input?.command as string || '').slice(0, 120)
              : tb.name === 'Write' || tb.name === 'Edit'
                ? (tb.input?.file_path as string || '')
                : tb.name === 'Read'
                  ? (tb.input?.file_path as string || '')
                  : tb.name === 'Grep'
                    ? (tb.input?.pattern as string || '')
                    : '';
            tools.push(snippet ? `${tb.name}(${snippet})` : (tb.name || 'unknown'));
          }
        }
      }
      logEvent({ type: 'turn', turn: turnCount, tools, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, elapsed: Math.round((Date.now() - startTime) / 1000) });

    } else if (msg.type === 'tool_use_summary') {
      const toolMsg = msg as unknown as SDKToolUseSummaryMessage;
      logEvent({ type: 'tool_done', summary: toolMsg.summary });

    } else if (msg.type === 'tool_progress') {
      const toolMsg = msg as unknown as SDKToolProgressMessage;
      logEvent({ type: 'tool_progress', tool: toolMsg.tool_name, elapsed: toolMsg.elapsed_time_seconds });

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
