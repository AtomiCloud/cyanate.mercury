/**
 * Web Generator SDK - Main Entry Point
 *
 * Usage:
 *   npm run dev -- --site-name my-site --input ./output --reference https://example.com
 */

// Load environment variables from .env file
// Can be overridden with --env flag
import { config } from 'dotenv';
import { WebGeneratorOrchestrator } from './orchestrator.js';
import { join } from 'path';
import { parseArgs } from 'util';

interface CliArgs {
  'site-name'?: string;
  input?: string;
  reference?: string;
  output?: string;
  env?: string;
  help?: boolean;
}

/**
 * Main CLI entry point
 */
export async function main() {
  // Parse CLI arguments
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      'site-name': { type: 'string' },
      input: { type: 'string' },
      reference: { type: 'string' },
      output: { type: 'string' },
      env: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values as CliArgs;

  // Load environment from specified file (or default .env)
  const envPath = args.env || '.env';
  config({ path: envPath });

  // Show help
  if (args.help) {
    console.log(`
Web Generator SDK - Generate Astro.js projects from scraped website data

Usage:
  npm run dev -- [options]

Options:
  --site-name <name>    Name of the site to generate (required)
  --input <path>        Path to scraper output directory (default: ./output)
  --reference <url>     Reference website URL for design extraction (optional)
  --output <path>       Output directory for generated project (default: ./projects/<site-name>)
  --env <file>          Path to .env file (default: .env)
  -h, --help            Show this help message

Example:
  npm run dev -- --site-name my-site --input ./output --reference https://example.com

Using custom env:
  npm run dev -- --site-name my-site --input ./output --env .env.production
    `);
    process.exit(0);
  }

  // Validate required arguments
  if (!args['site-name']) {
    console.error('❌ Error: --site-name is required');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  // Set defaults
  const inputPath = args.input || join(process.cwd(), '../output');
  const outputPath = args.output || join(process.cwd(), 'projects', args['site-name']);

  console.log('🔧 Web Generator SDK');
  console.log(`📦 Site name: ${args['site-name']}`);
  console.log(`📥 Input: ${inputPath}`);
  console.log(`🌐 Reference: ${args.reference || 'N/A'}`);
  console.log(`📤 Output: ${outputPath}`);
  console.log('');

  try {
    // Load scraper output
    const scraperOutput = await WebGeneratorOrchestrator.loadScraperOutput(inputPath);
    console.log(`✅ Loaded scraper output (${scraperOutput.content.pages.length} pages)`);

    // Create orchestrator
    const orchestrator = new WebGeneratorOrchestrator();

    // Run generation
    const result = await orchestrator.generate({
      siteName: args['site-name'],
      referenceUrl: args.reference,
      scraperOutput,
      outputPath,
    });

    // Report results
    if (result.success) {
      console.log('');
      console.log('✅ Generation complete!');
      console.log(`📁 Output: ${result.outputPath}`);
      if (result.warnings) {
        console.log(`⚠️  Warnings: ${result.warnings.join(', ')}`);
      }
      console.log('');
      console.log('Next steps:');
      console.log(`  cd ${result.outputPath}`);
      console.log('  npm run dev');
    } else {
      console.error('');
      console.error('❌ Generation failed!');
      if (result.errors) {
        result.errors.forEach((err) => console.error(`  - ${err}`));
      }
      process.exit(1);
    }

  } catch (error) {
    console.error('');
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
