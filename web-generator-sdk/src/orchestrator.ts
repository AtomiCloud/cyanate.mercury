/**
 * Web Generator Orchestrator
 *
 * Coordinates the generation of Astro.js projects from scraped website data.
 * This is the core agent that manages the 11-step pipeline.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_CONFIG } from './config.js';
import type { GeneratorConfig, GenerationResult, ScraperOutput } from './types.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { mkdir, cp, readdir, copyFile } from 'fs/promises';

/**
 * The Web Generator Orchestrator Agent
 */
export class WebGeneratorOrchestrator {
  private templatePath: string;
  private systemPrompt: string;
  // astro need to use static https://docs.astro.build/en/guides/routing/#static-ssg-mode to inject content from cms during buildtime
// todo add another step before generate step: plan layout and stucture
  //todo validate step: need to check functionality of each page, check button, check 404
  //todo step 4: focus on layout, content comes from cms. mobile accessibiltity. then design: background, font
  // design: layout(div, left right, support mobile?) -> design(does it look good?, background,) -> colour(flat, gradient) -> animation
  constructor() {
    this.templatePath = DEFAULT_CONFIG.TEMPLATE_PATH;

    // System prompt for the orchestrator
    this.systemPrompt = `You are the Web Generator Orchestrator. Your role is to coordinate the generation of Astro.js projects from scraped website data.

## Your Process (8-Step Pipeline)

1. **Setup**: Copy template to output directory
2. **Extract**: Extract design tokens from reference URL
3. **Plan Layout**: Create layout plan (page structure, sections, responsive strategy)
4. **Plan Brief**: Create design brief with layout + design tokens
5. **Generate**: Generate Astro code (layout-first, content from data files)
6. **Validate**: Run typecheck, astro check, build
7. **Iterate**: Fix any issues (loops up to 3 times)
8. **Done**: Return generated project path

## Layout-First Philosophy

IMPORTANT: Generate code in this order:
1. Layout structure (HTML divs, sections) FIRST with placeholder text
2. Then integrate content from src/data/content.json
3. Then apply visual design (colors, fonts, spacing)

Content is NEVER hardcoded - always read from src/data/content.json via src/lib/content.ts

## Template Reference

The Astro template is located at: ${this.templatePath}

This template contains:
- Pre-configured Astro + React + Tailwind CSS v4
- Shadcn UI configuration (components.json)
- Folder structure (components/ui, layouts, pages, styles, lib, data)
- src/lib/content.ts - content fetcher with getPageByUrl(), getAllPages(), etc.
- src/data/content.json - placeholder for scraper output
- Empty Layout.astro with <slot/>
- globals.css with OKLCH CSS variable placeholders

## Key Constraints

- Always copy the template to projects/[site-name]/ before modifying
- Copy content.json to src/data/content.json during generation
- Install Shadcn components during generation: npx shadcn add [component]
- Replace OKLCH CSS variables in globals.css with extracted design tokens
- Use OKLCH color format for all design tokens
- DO NOT hardcode content in .astro files - use content.ts helpers

## Error Handling

If any step fails, log the error and retry up to 3 times before giving up.

When providing your final result, output a complete summary of what was accomplished.`;
  }

  /**
   * Main generation pipeline
   * Implements the 11-step process from web-generator.md
   */
  async generate(config: GeneratorConfig): Promise<GenerationResult> {
    const { siteName, scraperOutput, outputPath } = config;

    console.log(`🚀 Starting generation for: ${siteName}`);
    console.log(`📁 Template path: ${this.templatePath}`);
    console.log(`📁 Output path: ${outputPath}`);

    try {
      // Step 1: Setup - Copy template to output directory
      await this.step1_Setup(siteName, outputPath);

      // Step 2: Extract - Extract design tokens from reference site
      const designTokens = await this.step2_ExtractDesignTokens(config);

      // Step 2b: Plan - Plan layout structure before code generation
      const layoutPlan = await this.step2b_PlanLayout(scraperOutput);

      // Step 3: Plan - Create design brief (now with layout context)
      const designBrief = await this.step3_CreateDesignBrief(scraperOutput, designTokens, layoutPlan);

      // Step 4: Generate - Generate Astro code (layout-first, content from data)
      await this.step4_GenerateAstroCode(outputPath, designBrief, scraperOutput, layoutPlan);

      // Step 5: Validate - Validate generated code
      const validation = await this.step5_Validate(outputPath);

      // Step 6: Iterate - Fix validation errors (loops until max iterations reached)
      let iterations = 0;
      while (!validation.passed && iterations < DEFAULT_CONFIG.MAX_ITERATIONS) {
        iterations++;
        console.log(`🔄 Iteration ${iterations}/${DEFAULT_CONFIG.MAX_ITERATIONS}`);
        await this.step6_IterateAndFix(outputPath, validation.errors);
        // Re-run validation
        const newValidation = await this.step5_Validate(outputPath);
        if (newValidation.passed) break;
      }

      // Step 7: Quality Test - Run quality checks (optional)
      const qualityResult = config.runQualityChecks
        ? await this.step7_QualityTest(outputPath)
        : { passed: true };

      // Step 8: Done - Return result
      const warnings: string[] = [];
      if (iterations > 0) {
        warnings.push(`Required ${iterations} iteration(s)`);
      }
      if (!qualityResult.passed) {
        warnings.push('Quality checks did not pass - review quality-scores.json for details');
      }

      return {
        success: true,
        outputPath,
        validationPassed: validation.passed && qualityResult.passed,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

    } catch (error) {
      return {
        success: false,
        outputPath,
        errors: [error instanceof Error ? error.message : String(error)],
        validationPassed: false,
      };
    }
  }

  /**
   * Step 1: Setup
   * Copy template to output directory
   */
  private async step1_Setup(siteName: string, outputPath: string): Promise<void> {
    console.log(`📋 Step 1: Setup - Copying template for ${siteName}...`);

    // Create output directory if it doesn't exist
    await mkdir(outputPath, { recursive: true });

    // Copy template directory contents to output, excluding node_modules and dist
    await this.copyDirectory(this.templatePath, outputPath);

    console.log(`✅ Template copied to ${outputPath}`);
  }

  /**
   * Copy directory recursively, excluding node_modules and dist
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    const entries = await readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      // Skip node_modules, dist, and lock files (will be generated fresh)
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.astro' ||
        entry.name === 'package-lock.json' ||
        entry.name === 'yarn.lock' ||
        entry.name === 'pnpm-lock.yaml' ||
        entry.name === 'bun.lockb'
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        await this.copyDirectory(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Step 2: Extract
   * Extract design tokens from reference site
   *
   * Skills used: extract-design-tokens
   */
  private async step2_ExtractDesignTokens(config: GeneratorConfig): Promise<string> {
    console.log('🎨 Step 2: Extract - Extracting design tokens...');

    const prompt = config.referenceUrl
      ? `Use the **extract-design-tokens** skill to analyze the reference site: ${config.referenceUrl}

Analyze the reference site and extract:
1. Colors (primary, secondary, accent, background, foreground, muted, border)
2. Typography (font families, sizes, weights)
3. Spacing scale
4. Border radius values
5. Shadow values

Return all colors in OKLCH format. Provide the result as a JSON object.`
      : `Use the **extract-design-tokens** skill to generate default design tokens for a modern, clean aesthetic.

Provide a default design token set in JSON format with all colors in OKLCH format:
- Primary: A nice blue/purple tone
- Secondary: A complementary color
- Accent: A vibrant highlight color
- Background: Light neutral
- Foreground: Dark text
- Muted: Subdued neutral
- Border: Subtle border color

Also include typography, spacing, border radius, and shadow tokens.`;

    return await this.runQuery(prompt, 'Step 2: Extract Design Tokens');
  }

  /**
   * Step 2b: Plan Layout
   * Create a layout plan for the site structure
   *
   * This step comes BEFORE design brief to establish:
   * - Page routing structure
   * - Section hierarchy per page
   * - Responsive breakpoint strategy
   * - Component composition
   *
   * Skills used: design-brief
   */
  private async step2b_PlanLayout(scraperOutput: ScraperOutput): Promise<string> {
    console.log('📐 Step 2b: Plan Layout - Creating layout plan...');

    const prompt = `Use the **design-brief** skill to create a layout plan for the site structure.

## Scraper Structure
\`\`\`json
${JSON.stringify(scraperOutput.structure).slice(0, 15000)}
\`\`\`

## Scraper Schema (defines content structure per page type)
\`\`\`json
${JSON.stringify(scraperOutput.schema).slice(0, 15000)}
\`\`\`

Create a layout plan that specifies:

1. **Page Routing Structure**
   - List all pages with their URL patterns
   - Identify static vs dynamic routes (e.g., /blog/[slug])
   - Map page relationships (navigation hierarchy)

2. **Section Composition for Each Page Type**
   - What sections appear on each page (e.g., landing: hero, features, testimonials, CTA)
   - Section order within each page
   - Which sections are shared (header, footer) vs page-specific

3. **Responsive Strategy**
   - Mobile-first breakpoints
   - Layout patterns (stack on mobile, grid on desktop)
   - Content prioritization for smaller screens

4. **Component Mapping**
   - Which reusable Astro components to create for each section type
   - Section-to-component relationship

5. **Content Data Requirements**
   - What content fields each section needs from content.json
   - Field mappings from schema to components

This layout plan will guide the code generation step. Focus on structure and layout - NOT colors or styling (that comes later).`;

    return await this.runQuery(prompt, 'Step 2b: Plan Layout');
  }

  /**
   * Step 3: Plan
   * Create design brief
   *
   * Skills used: design-brief
   */
  private async step3_CreateDesignBrief(scraperOutput: ScraperOutput, designTokens: string, layoutPlan: string): Promise<string> {
    console.log('📝 Step 3: Plan - Creating design brief...');

    const prompt = `Use the **design-brief** skill to create a comprehensive design brief based on the following:

## Scraper Output
\`\`\`json
${JSON.stringify(scraperOutput).slice(0, 15000)}
\`\`\`

## Design Tokens
\`\`\`
${designTokens}
\`\`\`

## Layout Plan
\`\`\`
${layoutPlan.slice(0, 10000)}
\`\`\`

Create a design brief that includes:
1. Site structure and navigation (from layout plan)
2. Page layouts for each page type (from layout plan)
3. Component requirements (from layout plan)
4. Content mapping (which content fields go where)
5. Styling approach (colors, typography, spacing from design tokens)

The brief should guide the Astro code generation process. Use the layout plan as the source of truth for structure.`;

    return await this.runQuery(prompt, 'Step 3: Create Design Brief');
  }

  /**
   * Step 4: Generate
   * Generate Astro code
   *
   * Skills used: astro-codegen, Astro, Shadcn, Frontend Design
   */
  private async step4_GenerateAstroCode(outputPath: string, designBrief: string, scraperOutput: ScraperOutput, layoutPlan: string): Promise<void> {
    console.log('🔨 Step 4: Generate - Generating Astro code...');

    const prompt = `Use the **astro-codegen** skill to generate Astro pages, components, and layouts for the output directory: ${outputPath}

Consult the **Astro** skill for Astro framework best practices, CLI commands, and project structure.
Consult the **Shadcn** skill for proper component usage and installation patterns.
Reference the **Frontend Design** skill for layout best practices and design patterns.

## Layout Plan
\`\`\`
${layoutPlan.slice(0, 10000)}
\`\`\`

## Design Brief
\`\`\`
${designBrief.slice(0, 10000)}
\`\`\`

## Content Data (to be used at build time)
\`\`\`json
${JSON.stringify(scraperOutput.content).slice(0, 15000)}
\`\`\`

## Instructions - LAYOUT FIRST APPROACH

Follow this phased approach:

### Phase 1: Data Setup
1. Copy content.json to src/data/content.json (the scraper's content data)
2. Review the src/lib/content.ts helper - it already has functions to read content

### Phase 2: Layout Structure (DO THIS FIRST)
1. Create the page file structure matching the layout plan's routing
2. For each page, create the HTML/Tailwind structure (divs, sections) - use PLACEHOLDER text like "Hero Title", "Feature 1"
3. DO NOT use real content from content.json yet - focus purely on layout/structure
4. Ensure responsive breakpoints match the layout plan
5. Use import to read content: \`import { getPageByUrl } from '../lib/content'\`

### Phase 3: Content Integration
1. Now replace placeholders with actual content from src/data/content.json
2. Use the content.ts helper functions (getPageByUrl, getAllPages, etc.)
3. Map schema fields to component props

### Phase 4: Visual Design
1. Apply design tokens (colors, typography, spacing) from design brief to globals.css
2. Refine component styling to match the design brief aesthetic

### Important Constraints
- DO NOT hardcode content in .astro files - all content must come from src/data/content.json via content.ts
- Layout structure (HTML divs, sections) comes FIRST, before styling
- Follow the layout plan's section composition exactly
- Use Astro's static generation - content is injected at BUILD time, not runtime

Output directory: ${outputPath}
Template directory: ${this.templatePath}

Start by reading the existing template files and src/lib/content.ts to understand the structure.

When you're done, provide a summary of all files created and modified.`;

    await this.runQuery(prompt, 'Step 4: Generate Astro Code');
  }

  /**
   * Step 5: Validate
   * Validate generated code
   *
   * Skills used: validate-and-repair, Astro
   */
  private async step5_Validate(outputPath: string): Promise<{ passed: boolean; errors?: string[] }> {
    console.log('✅ Step 5: Validate - Validating generated code...');

    const prompt = `Use the **validate-and-repair** skill to validate the Astro project at: ${outputPath}

Consult the **Astro** skill for Astro CLI commands and project structure reference.

Run the following validation checks:
1. Type check: npm run typecheck
2. Astro check: npx astro check
3. Build test: npm run build

For each check:
- Run the command
- Capture and report any errors
- If all checks pass without errors, output "✅ VALIDATION_PASSED" at the end

If there are errors, list them clearly so they can be fixed.`;

    const result = await this.runQuery(prompt, 'Step 5: Validate');
    const passed = result.includes('VALIDATION_PASSED') || !result.toLowerCase().includes('error');

    return {
      passed,
      errors: passed ? undefined : this.extractErrors(result),
    };
  }

  /**
   * Step 6: Iterate
   * Fix issues found during validation
   *
   * Skills used: iterate-and-fix, Astro
   */
  private async step6_IterateAndFix(outputPath: string, errors?: string[]): Promise<void> {
    console.log('🔧 Step 6: Iterate - Fixing issues...');

    const prompt = `Use the **iterate-and-fix** skill to fix the following issues in the Astro project at ${outputPath}:

Consult the **Astro** skill for Astro framework reference when fixing issues.

## Errors
${errors?.join('\n') || 'General quality improvements needed.'}

## Instructions
1. Read the problematic files
2. Edit them to fix the errors
3. Re-run validation to confirm the fixes

Fix all the issues listed above. After making changes, run the validation commands again to confirm the fixes work.`;

    await this.runQuery(prompt, 'Step 6: Iterate and Fix');
  }

  /**
   * Step 7: Quality Test
   * Run quality checks on the generated code
   *
   * Skills used: test-and-quality
   */
  private async step7_QualityTest(outputPath: string): Promise<{ passed: boolean; scores?: Record<string, number> }> {
    console.log('🧪 Step 10: Quality Test - Running quality checks...');

    const prompt = `Use the **test-and-quality** skill to evaluate the visual quality of the generated Astro project at: ${outputPath}

Run the following quality checks:
1. Functional test - Start dev server, visit index page, check for console errors
2. Quality evaluation - Score each dimension (layoutConsistency, designTokenUsage, componentComposition, responsiveDesign, semanticHTML, visualAppeal)
3. Responsive check - Test at mobile (375px), tablet (768px), and desktop (1920px) viewports

Save results as quality-scores.json and test-report.json.
If all checks pass with scores >= 7/10, output "✅ QUALITY_PASSED" at the end.`;

    const result = await this.runQuery(prompt, 'Step 10: Quality Test');
    const passed = result.includes('QUALITY_PASSED');

    return {
      passed,
      scores: passed ? undefined : { overall: 5 }, // Placeholder for actual scores
    };
  }

  /**
   * Run a query and return the result text
   */
  private async runQuery(prompt: string, stepName: string = 'Unknown'): Promise<string> {
    const startTime = Date.now();

    try {
      const result = query({
        prompt,
        options: {
          systemPrompt: this.systemPrompt,
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'WebFetch'],
          cwd: process.cwd(),
          // Note: Environment variables (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, LLM_MODEL)
          // are loaded from .env in index.ts and inherited by child process
          // Load project settings to access custom skills
          settingSources: ['project'],
          // Bypass permissions for headless/Kubernetes execution
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
      });

      let output = '';
      let turnCount = 0;

      for await (const message of result) {
        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            output = resultMsg.result;
            turnCount = resultMsg.num_turns || 0;
          } else {
            // Handle error result (error_during_execution, error_max_turns, etc.)
            const errorMsg = (resultMsg as any).errors?.join('; ') || 'Unknown error';
            console.error(`❌ ${stepName} error:`, errorMsg);
            throw new Error(`${stepName} failed: ${errorMsg}`);
          }
        }
      }

      const duration = Date.now() - startTime;
      console.log(`📊 ${stepName}: ${turnCount} turn(s), ${duration}ms`);

      return output;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ ${stepName} failed after ${duration}ms:`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Extract error messages from validation output
   */
  private extractErrors(output: string): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
        errors.push(line.trim());
      }
    }

    return errors.slice(0, 10); // Limit to 10 errors
  }

  /**
   * Load scraper output from JSON files
   */
  static async loadScraperOutput(inputPath: string): Promise<ScraperOutput> {
    const structurePath = join(inputPath, 'structure.json');
    const schemaPath = join(inputPath, 'schema.json');
    const contentPath = join(inputPath, 'content.json');

    const [structure, schema, content] = await Promise.all([
      readFile(structurePath, 'utf-8').then(JSON.parse),
      readFile(schemaPath, 'utf-8').then(JSON.parse),
      readFile(contentPath, 'utf-8').then(JSON.parse),
    ]);

    return { structure, schema, content };
  }
}
