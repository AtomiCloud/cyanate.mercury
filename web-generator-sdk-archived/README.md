# Web Generator SDK

An Agent SDK that generates Astro.js projects from scraped website data.

## Overview

This SDK uses the Claude Agent SDK to orchestrate the generation of complete Astro.js websites from scraped content. It follows a template-based approach where a pre-configured Astro template is copied and populated with content.

## Architecture

```
web-generator-sdk/          # Agent SDK project (this repo)
├── src/
│   ├── index.ts           # Main CLI entry point
│   ├── orchestrator.ts    # Core generation pipeline using query() API
│   ├── manifest.ts        # Skills and tools definitions
│   ├── config.ts          # Configuration
│   └── types.ts           # TypeScript definitions
├── template/
│   └── astro-project/     # Fixed Astro template
├── .claude/
│   └── skills/            # Custom skills (to be created)
└── projects/              # Generated sites
```

## The 11-Step Pipeline

1. **Setup** - Copy template to output directory
2. **Extract** - Extract design tokens from reference site
3. **Plan** - Create design brief
4. **Generate** - Generate Astro pages and components
5. **Validate** - Validate generated code
6-10. **Iterate** - Fix issues (up to 3 iterations)
11. **Done** - Return generated project

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file with your Anthropic API key:

```bash
cp .env.example .env
# Edit .env and add your API key
```

Get your API key from: https://console.anthropic.com/

## Usage

```bash
# Generate a site from scraper output
npm run dev -- --site-name my-site --input ../output --reference https://example.com

# Show help
npm run dev -- --help
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--site-name` | Name of the site to generate (required) | - |
| `--input` | Path to scraper output directory | `./output` |
| `--reference` | Reference website URL for design extraction | - |
| `--output` | Output directory for generated project | `./projects/<site-name>` |
| `--help` | Show help message | - |

## Custom Skills

The SDK uses 6 custom skills for the generation pipeline:

| Skill | Purpose |
|-------|---------|
| `extract-design-tokens` | Extract design tokens from reference site |
| `design-brief` | Create comprehensive design brief |
| `astro-codegen` | Generate Astro pages and components |
| `validate-and-repair` | Validate and repair generated code |
| `test-and-quality` | Run quality checks |
| `iterate-and-fix` | Iterate on feedback to fix issues |

**Note**: These skills will be created in the `.claude/skills/` directory.

## Tech Stack

- **Claude Agent SDK** v0.2.74 - Agent orchestration using `query()` API
- **TypeScript** - Type safety
- **Astro.js** - Static site framework (in template)
- **Tailwind CSS v4** - Styling (in template)
- **Shadcn UI** - Component library (in template)
- **OKLCH** - Color format for design tokens

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build

# Run
npm start
```

## License

MIT
