/**
 * Project manifest for the Web Generator SDK
 *
 * This file defines the project's skills, tools, and configuration
 * for use with the Claude Agent SDK.
 */

/**
 * Skill definitions for the Web Generator
 */
export const skills = {
  // Custom skills for the generation pipeline
  'extract-design-tokens': {
    description: 'Extracts design tokens (colors, typography, spacing) from reference website',
  },
  'design-brief': {
    description: 'Creates a comprehensive design brief based on scraper output and design tokens',
  },
  'astro-codegen': {
    description: 'Generates Astro.js pages, components, and layouts based on design brief',
  },
  'validate-and-repair': {
    description: 'Validates generated code and repairs common issues',
  },
  'test-and-quality': {
    description: 'Runs quality checks and tests on generated project',
  },
  'iterate-and-fix': {
    description: 'Iterates on feedback to fix issues and improve quality',
  },
} as const;

/**
 * Tool definitions for the Web Generator
 */
export const tools = {
  read: {
    description: 'Read file contents',
  },
  write: {
    description: 'Write or create files',
  },
  edit: {
    description: 'Edit existing files',
  },
  bash: {
    description: 'Execute shell commands',
  },
} as const;

/**
 * System prompt for the orchestrator
 */
export const SYSTEM_PROMPT = `You are the Web Generator Orchestrator. Your role is to coordinate the generation of Astro.js projects from scraped website data.

## Your Process

1. **Setup**: Load scraper output (structure.json, schema.json, content.json)
2. **Extract**: Extract design tokens from reference URL
3. **Plan**: Create design brief
4. **Generate**: Generate Astro code
5. **Validate**: Validate and repair
6. **Iterate**: Fix any issues
7. **Done**: Return generated project path

## Template Reference

The Astro template is located at: ../template/astro-project

This template contains:
- Pre-configured Astro + React + Tailwind CSS v4
- Shadcn UI configuration (components.json)
- Folder structure (components/ui, layouts, pages, styles, lib)
- Empty Layout.astro with <slot/>
- globals.css with OKLCH CSS variable placeholders

## Key Constraints

- Always copy the template to projects/[site-name]/ before modifying
- Install Shadcn components during generation: bunx shadcn add [component]
- Replace OKLCH CSS variables in globals.css with extracted design tokens
- Use OKLCH color format for all design tokens
- Follow the 11-step pipeline defined in web-generator.md

## Error Handling

If any step fails, log the error and retry up to 3 times before giving up.`;

/**
 * Permission configuration
 */
export const permissions = {
  read: ['**/*'],
  write: ['projects/**/*', '../template/**/*'],
  bash: ['bun *', 'npm *', 'node *', 'astro *'],
} as const;
