/**
 * Phase 0: ANALYZE
 *
 * Extract style fingerprint, 7-layer design tokens, and component recipes
 * from the reference URL. Outputs structured JSON files to scratch directory.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';
import { validateDesignTokens } from '../lib/validate-boundary.js';

export const analyzeStep: Step = {
  id: 'analyze',
  name: 'Phase 0: Analyze',
  description: 'Extract style fingerprint, 7-layer design tokens, component recipes',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const styleClassification = await readFile(
      join(process.cwd(), 'DESIGN-STYLE-CLASSIFICATION.md'), 'utf-8',
    ).catch(() => '');
    const tokenResearch = await readFile(
      join(process.cwd(), 'DESIGN-TOKEN-RESEARCH.md'), 'utf-8',
    ).catch(() => '');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Use the **extract-design-tokens** skill to analyze the reference site: ${ctx.referenceUrl || 'not provided'}

${rejectionSection}
${styleClassification ? `## Style Classification Reference\n${styleClassification.slice(0, 8000)}\n` : ''}
${tokenResearch ? `## Token Architecture Reference\n${tokenResearch.slice(0, 8000)}\n` : ''}

Analyze the reference site and extract THREE structured JSON files.

The goal is to capture a TRANSFERABLE design system from the reference, not to copy its brand identity literally.
The output must be reusable across arbitrary source-site content and information architecture.

## 1. style-fingerprint.json

Classify the site's visual personality with these dimensions (0.0-1.0):
- ornament (minimal to highly decorative)
- playfulness (serious to playful)
- warmth (cool to warm)
- density (airy to dense)
- motion (static to animated)
- depth (flat to layered)
- darkness (light to dark)
- formality (casual to formal)

Include primary style category (e.g., "minimalist", "brutalist", "corporate") and secondary styles.
Include treatments: surface, corners, shadows, borders, gradients, blur, transparency, animation_style.
Set confidence score (0.0-1.0).

Required shape:
\`\`\`json
{
  "style": {
    "primary": "...",
    "secondary": ["..."],
    "dimensions": {
      "ornament": 0.0,
      "playfulness": 0.0,
      "warmth": 0.0,
      "density": 0.0,
      "motion": 0.0,
      "depth": 0.0,
      "darkness": 0.0,
      "formality": 0.0
    },
    "treatments": {
      "surface": "...",
      "corners": "...",
      "shadows": "...",
      "borders": "...",
      "gradients": "...",
      "blur": true,
      "transparency": true,
      "animation_style": "..."
    }
  },
  "confidence": 0.0
}
\`\`\`

## 2. design-tokens.json

Extract a 7-layer token architecture. The TOP-LEVEL KEYS must be exactly these names (no layer prefixes):

\`\`\`json
{
  "atomic": { ... },
  "gradients": { ... },
  "layout": { ... },
  "componentSpacing": { ... },
  "motion": { ... },
  "surfaces": { ... },
  "visualIdentity": { ... }
}
\`\`\`

Each layer:
1. **atomic** - colors, typography, spacing, borderRadius, shadows
2. **gradients** - gradient definitions (type, angle, stops)
3. **layout** - grid, container, breakpoints, sections, density, rhythm
4. **componentSpacing** - inset, insetSquish, insetStretch, stack, inline, grid
5. **motion** - duration, easing, state (hover/focus/active/disabled), scroll, skeleton
6. **surfaces** - glass (must have real values: backdropBlur, background, borderColor), texture (must have real values: type, opacity, etc.), imageTreatment
7. **visualIdentity** - colorDistribution (must have keys: dominant, secondary, accent — NOT "neutral"), borders

CRITICAL: Do NOT prefix the keys with "layer0_", "layer1_", etc. Use the exact key names shown above.

All colors in OKLCH format. Include actual measured values from the site.
Use generic semantic token names and scales, never reference-brand names, product names, or company-specific naming.
Avoid embedding proprietary brand identifiers in token keys, recipe names, or typography labels.

## 3. component-recipes.json

For each component type found (button, card, navigation, input, badge, etc.):
- **base**: padding, fontWeight, borderRadius, fontSize, lineHeight, etc.
- **variants**: at least 2 (e.g., primary, secondary, ghost, destructive, link for buttons)
- **states**: hover, focus, active, disabled transitions/transforms

Use CSS values like "token:primary" to reference design tokens where appropriate.
Recipes should capture reusable interaction and styling patterns, not brand-specific motifs that only fit the reference site's own product/domain.

Required shape:
\`\`\`json
{
  "recipes": {
    "button": {
      "base": { ... },
      "variants": { "primary": { ... }, "secondary": { ... } },
      "states": { ... }
    },
    "card": {
      "base": { ... },
      "variants": { "default": { ... }, "feature": { ... } },
      "states": { ... }
    }
  }
}
\`\`\`

## IMPORTANT
- Write all 3 files to the scratch directory: ${ctx.scratchDir}
- Each file must be valid JSON
- All 7 token layers must have non-empty values
- Component recipes must have base + at least 2 variants
- If no reference URL, generate neutral, broadly reusable defaults that do not assume any specific industry, site archetype, or brand style
- Prefer broadly available font categories/fallback stacks over proprietary font branding when encoding typography tokens
- Do not output prose instead of files`;

    await agentQuery({
      prompt,
      cwd: ctx.scratchDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const errors: string[] = [];

    try {
      const styleFingerprint = JSON.parse(await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8'));
      validateStyleFingerprint(styleFingerprint);
    } catch (e) {
      errors.push(`style-fingerprint.json: ${e instanceof Error ? e.message : 'invalid or missing'}`);
    }

    try {
      const designTokens = JSON.parse(await readFile(join(ctx.scratchDir, 'design-tokens.json'), 'utf-8'));
      validateDesignTokens(designTokens);
      validateDesignTokensSemantics(designTokens);
    } catch (e) {
      errors.push(`design-tokens.json: ${e instanceof Error ? e.message : 'invalid or missing'}`);
    }

    try {
      const componentRecipes = JSON.parse(await readFile(join(ctx.scratchDir, 'component-recipes.json'), 'utf-8'));
      validateComponentRecipes(componentRecipes);
    } catch (e) {
      errors.push(`component-recipes.json: ${e instanceof Error ? e.message : 'invalid or missing'}`);
    }

    return {
      status: errors.length === 0 ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};

const REQUIRED_DIMENSIONS = [
  'ornament',
  'playfulness',
  'warmth',
  'density',
  'motion',
  'depth',
  'darkness',
  'formality',
] as const;

function validateStyleFingerprint(data: unknown): void {
  if (!data || typeof data !== 'object') throw new Error('must be an object');
  const root = data as Record<string, unknown>;
  const style = root.style;
  if (!style || typeof style !== 'object') throw new Error('missing style object');
  const styleObj = style as Record<string, unknown>;
  if (typeof styleObj.primary !== 'string' || styleObj.primary.trim() === '') {
    throw new Error('missing style.primary');
  }
  if (!Array.isArray(styleObj.secondary)) {
    throw new Error('style.secondary must be an array');
  }
  const dimensions = styleObj.dimensions;
  if (!dimensions || typeof dimensions !== 'object') throw new Error('missing style.dimensions');
  for (const key of REQUIRED_DIMENSIONS) {
    const value = (dimensions as Record<string, unknown>)[key];
    if (typeof value !== 'number' || value < 0 || value > 1) {
      throw new Error(`style.dimensions.${key} must be a number between 0 and 1`);
    }
  }
  const treatments = styleObj.treatments;
  if (!treatments || typeof treatments !== 'object') throw new Error('missing style.treatments');
  for (const key of ['surface', 'corners', 'shadows', 'borders', 'gradients', 'animation_style']) {
    const value = (treatments as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`style.treatments.${key} must be a non-empty string`);
    }
  }
  for (const key of ['blur', 'transparency']) {
    if (typeof (treatments as Record<string, unknown>)[key] !== 'boolean') {
      throw new Error(`style.treatments.${key} must be a boolean`);
    }
  }
  const confidence = typeof root.confidence === 'number'
    ? root.confidence
    : (typeof styleObj.confidence === 'number' ? styleObj.confidence : undefined);
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be a number between 0 and 1');
  }
}

function validateDesignTokensSemantics(data: unknown): void {
  if (!data || typeof data !== 'object') throw new Error('must be an object');
  const obj = data as Record<string, unknown>;
  for (const key of ['atomic', 'gradients', 'layout', 'componentSpacing', 'motion', 'surfaces', 'visualIdentity']) {
    const layer = obj[key];
    if (!layer || typeof layer !== 'object' || Object.keys(layer as Record<string, unknown>).length === 0) {
      throw new Error(`missing or empty layer: ${key}`);
    }
  }
  const surfaces = obj.surfaces as Record<string, unknown>;
  const glass = surfaces?.glass;
  if (!glass || typeof glass !== 'object' || Object.keys(glass as Record<string, unknown>).length === 0) {
    throw new Error('surfaces.glass must be a non-empty object');
  }
  let glassHasRequiredValues = false;
  for (const [variantName, variant] of Object.entries(glass as Record<string, unknown>)) {
    if (!variant || typeof variant !== 'object') continue;
    const variantObj = variant as Record<string, unknown>;
    const backdropBlur = variantObj.backdropBlur;
    const background = variantObj.background;
    const borderColor = variantObj.borderColor;
    if (
      typeof backdropBlur === 'string' && backdropBlur.trim() !== ''
      && typeof background === 'string' && background.trim() !== ''
      && typeof borderColor === 'string' && borderColor.trim() !== ''
    ) {
      glassHasRequiredValues = true;
      break;
    }
    if (variantName === 'backdropBlur' || variantName === 'background' || variantName === 'borderColor') {
      glassHasRequiredValues = true;
    }
  }
  if (!glassHasRequiredValues) {
    throw new Error('surfaces.glass must contain at least one variant with backdropBlur, background, and borderColor');
  }
  const texture = surfaces?.texture;
  if (!texture || typeof texture !== 'object' || Object.keys(texture as Record<string, unknown>).length === 0) {
    throw new Error('surfaces.texture must be a non-empty object');
  }
  const textureHasRealValues = Object.values(texture as Record<string, unknown>).some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return Object.values(entry as Record<string, unknown>).some((value) =>
      (typeof value === 'string' && value.trim() !== '') || typeof value === 'number' || typeof value === 'boolean'
    );
  });
  if (!textureHasRealValues) {
    throw new Error('surfaces.texture must contain at least one variant with real values');
  }
  const colorDistribution = ((obj.visualIdentity as Record<string, unknown>)?.colorDistribution ?? null) as Record<string, unknown> | null;
  if (!colorDistribution) throw new Error('visualIdentity.colorDistribution missing');
  for (const key of ['dominant', 'secondary', 'accent']) {
    const value = colorDistribution[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`visualIdentity.colorDistribution.${key} missing`);
    }
  }
}

function validateComponentRecipes(data: unknown): void {
  if (!data || typeof data !== 'object') throw new Error('must be an object');
  const root = data as Record<string, unknown>;
  const recipes = (root.recipes && typeof root.recipes === 'object')
    ? root.recipes as Record<string, unknown>
    : root;
  for (const component of ['button', 'card']) {
    const entry = recipes[component];
    if (!entry || typeof entry !== 'object') throw new Error(`missing ${component} recipe`);
    const recipe = entry as Record<string, unknown>;
    if (!recipe.base || typeof recipe.base !== 'object' || Object.keys(recipe.base as Record<string, unknown>).length === 0) {
      throw new Error(`${component}.base missing or empty`);
    }
    const variants = recipe.variants;
    if (!variants || typeof variants !== 'object') throw new Error(`${component}.variants missing`);
    const variantCount = Object.keys(variants as Record<string, unknown>).length;
    if (variantCount < 2) throw new Error(`${component}.variants must contain at least 2 variants`);
  }
}
