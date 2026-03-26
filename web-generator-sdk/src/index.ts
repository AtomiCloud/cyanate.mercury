/**
 * Web Generator SDK v2 - Entry Point
 *
 * Usage:
 *   bun src/index.ts                         Run full pipeline (TUI mode)
 *   bun src/index.ts --non-interactive       Verbose logging mode
 *   bun src/index.ts --from runs/.../step-4 Resume from a step
 */

import { parseArgs } from 'util';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { runPipeline } from './pipeline/runner.js';

interface CliArgs {
  from?: string;
  config?: string;
  'non-interactive'?: boolean;
  help?: boolean;
}

export async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      from: { type: 'string' },
      config: { type: 'string', default: 'cui.json' },
      'non-interactive': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  }).values as CliArgs;

  if (args.help) {
    console.log(`
Web Generator SDK v2

Usage:
  bun src/index.ts                            Run full pipeline (TUI)
  bun src/index.ts --non-interactive            Verbose logging
  bun src/index.ts --from runs/X/step-N-id     Resume from a step
  bun src/index.ts --config path/to/cui.json   Use custom config

Options:
  --from <path>         Resume from a previous run's step
  --config <path>       Path to cui.json (default: ./cui.json)
  --non-interactive     Verbose per-turn logging instead of TUI
  -h, --help            Show help
`);
    process.exit(0);
  }

  const configPath = resolve(args.config!);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    console.error(`Error: Cannot read config at ${configPath}`);
    console.error('Create a cui.json file. Example:');
    console.error(JSON.stringify({ input: '../example', reference: 'https://example.com/', profile: 'claude', steps: {} }, null, 2));
    process.exit(1);
  }

  await runPipeline(config, args.from, { nonInteractive: args['non-interactive'] });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
