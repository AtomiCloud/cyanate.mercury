/**
 * RTK (Rust Token Killer) hook for the Agent SDK.
 *
 * Intercepts Bash tool calls and rewrites supported commands to use RTK,
 * which filters and compresses output before it enters the LLM context.
 * Saves 60-90% tokens on common dev commands (git, ls, tree, find, etc.).
 */

import type {
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Commands RTK can proxy. Only include commands the agents actually use.
 * Each entry is the first token of a bash command.
 */
const RTK_COMMANDS = new Set([
  'git',
  'ls',
  'tree',
  'find',
  'grep',
  'rg',
  'diff',
  'cat',       // rtk read
  'head',      // rtk read
  'tail',      // rtk read
  'bun',       // rtk pnpm (compatible)
  'npm',
  'npx',
  'pnpm',
  'curl',
  'wget',
  'tsc',
  'wc',
]);

/** Commands that map to a different RTK subcommand */
const RTK_ALIASES: Record<string, string> = {
  'rg': 'grep',
  'cat': 'read',
  'head': 'read',
  'tail': 'read',
};

/**
 * Commands that should NOT be rewritten even if they start with a supported command.
 * E.g. `git commit`, `git push` — we want full output for mutations.
 */
const RTK_SKIP_PATTERNS = [
  /^git\s+(commit|push|merge|rebase|cherry-pick|tag)/,
  /^bun\s+(install|add|remove|create|init|upgrade)/,
  /^npm\s+(install|uninstall|init|publish)/,
  /^npx\s+/,  // npx runs arbitrary commands, don't wrap
];

const RTK_BIN = '/Users/erng/.nix-profile/bin/rtk';

function rewriteCommand(command: string): string | null {
  const trimmed = command.trim();

  // Extract the first token (the command name)
  const firstToken = trimmed.split(/\s+/)[0];
  if (!firstToken || !RTK_COMMANDS.has(firstToken)) return null;

  // Skip mutation commands where full output matters
  for (const pattern of RTK_SKIP_PATTERNS) {
    if (pattern.test(trimmed)) return null;
  }

  // Map to RTK subcommand
  const rtkSub = RTK_ALIASES[firstToken] || firstToken;
  const rest = trimmed.slice(firstToken.length);

  rtkStats.rewritten++;
  return `${RTK_BIN} ${rtkSub}${rest}`;
}

/** Simple counter for monitoring RTK hook activity */
export const rtkStats = { checked: 0, rewritten: 0 };

async function rtkPreToolUseHook(
  input: HookInput,
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') {
    return { continue: true };
  }

  const preInput = input as PreToolUseHookInput;
  if (preInput.tool_name !== 'Bash') {
    return { continue: true };
  }

  const toolInput = preInput.tool_input as { command?: string } | undefined;
  const command = toolInput?.command;
  rtkStats.checked++;
  if (!command) return { continue: true };

  // Handle piped commands: only rewrite the first command in a pipe chain
  // For chained commands (&&, ;), rewrite each segment
  // For simplicity, only rewrite simple (non-piped, non-chained) commands
  if (command.includes('|') || command.includes('&&') || command.includes(';')) {
    return { continue: true };
  }

  const rewritten = rewriteCommand(command);
  if (!rewritten) return { continue: true };

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      updatedInput: { command: rewritten },
    },
  };
}

/** Hook matcher for the Agent SDK's hooks option */
export const rtkHookMatcher: HookCallbackMatcher = {
  matcher: 'Bash',
  hooks: [rtkPreToolUseHook],
};
