import { readFile, writeFile, readdir } from 'fs/promises';
import { join, extname } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const mobileStep: Step = {
  id: 'mobile',
  name: 'Phase 2b: Mobile Friendliness',
  description: 'Fix mobile navigation, overflow, and small-screen responsiveness',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const registry = await readFile(join(workingDir, 'output/reduced/registry.json'), 'utf-8').catch(() => '{}');
    const manifest = await readFile(join(workingDir, 'output/reduced/interaction-manifest.json'), 'utf-8').catch(() => '{"patterns":[],"pages":[]}');
    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer/Runtime Feedback\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `${rejectionSection}
**TURN BUDGET WARNING:** You have a limited number of turns. Prioritize fixing the most impactful mobile issues first. If running short on turns, emit a final summary and stop — do not loop endlessly on edge cases.

Improve mobile friendliness for the Astro project in the current directory.

Consult the **Astro** skill for Astro framework reference.

## Scope
This phase owns small-screen responsiveness and mobile interaction ergonomics only.
Do NOT redesign the site or change the overall page architecture.
Do NOT install, remove, or upgrade dependencies.

## Inputs
### Registry
\`\`\`json
${registry}
\`\`\`

### Interaction Manifest
\`\`\`json
${manifest}
\`\`\`

## Required work
- Ensure mobile navigation remains fully usable when desktop nav is hidden.
- Add or repair mobile nav toggle/drawer behavior if the layout phase left only desktop navigation.
- Eliminate horizontal overflow at mobile widths.
- Make drawers/popups/mobile menus reachable and dismissible.
- Normalize small-screen container padding and ensure content grids stack appropriately on narrow screens.
- Keep the existing route/component structure; apply focused mobile fixes only.

## Rules
- No package installs or toolchain edits.
- No major structural rewrites unrelated to mobile behavior.
- Preserve heading hierarchy and existing desktop behavior.
- Prefer CSS/media-query fixes and minimal JS toggles for mobile nav/drawers.

### Phase focus
This phase focuses on mobile responsiveness. You MAY keep or adjust existing colors/fonts to maintain visual consistency on small screens — later phases will refine them.

### Mobile nav drawer pattern (REQUIRED if using a slide-in drawer)
If implementing a mobile nav drawer with class-based toggle (e.g. \`.mobile-nav\` toggled with \`.is-open\`):
\`\`\`css
/* Closed state — drawer hidden off-screen */
.mobile-nav {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(320px, 85vw);
  transform: translateX(100%);  /* hidden by default */
}
/* Open state — drawer slides in */
.mobile-nav.is-open {
  transform: translateX(0);
}
/* Backdrop — MUST only show when active (use .is-visible or JS toggle, NOT media query display:block) */
.mobile-nav-backdrop {
  display: none;  /* hidden by default */
  position: fixed; inset: 0; z-index: 200;
}
.mobile-nav-backdrop.is-visible {
  display: block;
}
\`\`\`
NEVER add \`display: block\` to a backdrop element in a media query — that makes it permanently block all interactions.

## Mobile Nav Verification
After implementing the mobile navigation toggle:
1. The closed state MUST use both transform AND visibility (or display:none) — opacity:0 alone leaves the element interactable but invisible.
2. The open state MUST make the element visible AND interactable.
3. Do NOT use setTimeout for visibility toggling — use CSS transitions with transitionend events instead.
4. Test: if you remove the 'hidden' class, the element should animate in. If you add it back, it should animate out.

## Validation
- Focus on mobile viewport usability and overflow fixes.
- Return a concise summary of the changes.`;

    await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
      maxTurns: 100,
    });

    // sanitizeMobilePhaseOutput removed — was stripping legitimate CSS (colors, fonts, transforms)
    await normalizeMobileHorizontalPadding(workingDir);
    await ensureMobileNavBehavior(workingDir);
    await fixMobileDrawerCSS(workingDir);

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

async function normalizeMobileHorizontalPadding(workingDir: string): Promise<void> {
  const headerPath = join(workingDir, 'src/components/Header.astro');
  try {
    const source = await readFile(headerPath, 'utf-8');
    let repaired = source;
    repaired = repaired.replace(/\.container\s*\{([\s\S]*?)padding:\s*0\s+32px;([\s\S]*?)\}/g, '.container {$1padding: 0 24px;$2}');
    repaired = repaired.replace(/@media \(max-width: 961px\) \{([\s\S]*?)\}/g, (block) => block.includes('.container') ? block : block.replace('{', '{\n    .container { padding: 0 16px; }'));
    if (repaired !== source) {
      await writeFile(headerPath, repaired, 'utf-8');
    }
  } catch {
    // ignore missing header
  }
}

// --- Mobile phase sanitizer: strip forbidden CSS declarations ---

const MOBILE_FORBIDDEN_DECLARATIONS = [
  // Typography (belongs to design phase)
  /(^|[;\s{])font-size\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-weight\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-family\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-style\s*:[^;]+;?/gmi,
  /(^|[;\s{])line-height\s*:[^;]+;?/gmi,
  /(^|[;\s{])letter-spacing\s*:[^;]+;?/gmi,
  // Colors (belongs to color phase)
  /(^|[;\s{])color\s*:[^;]+;?/gmi,
  /(^|[;\s{])background-color\s*:[^;]+;?/gmi,
  /(^|[;\s{])border-color\s*:[^;]+;?/gmi,
  /(^|[;\s{])fill\s*:[^;]+;?/gmi,
  /(^|[;\s{])stroke\s*:[^;]+;?/gmi,
  /(^|[;\s{])background\s*:\s*(?:oklch|hsl|rgb|#)[^;]+;?/gmi,
  // Motion (belongs to motion phase)
  // Note: transform with translateX/Y is allowed for mobile drawer off-screen positioning
  /(^|[;\s{])transition\s*:[^;]+;?/gmi,
  /(^|[;\s{])animation\s*:[^;]+;?/gmi,
  /(^|[;\s{])transform\s*:\s*(?!\s*translateX|\s*translateY)[^;]+;?/gmi,
];

async function sanitizeMobilePhaseOutput(workingDir: string): Promise<void> {
  const srcDir = join(workingDir, 'src');
  const files = await listMobileSourceFiles(srcDir);
  await Promise.all(files.map(async (file) => {
    const original = await readFile(file, 'utf-8');
    const sanitized = sanitizeMobileSource(original);
    if (sanitized !== original) {
      await writeFile(file, sanitized, 'utf-8');
    }
  }));
}

function sanitizeMobileSource(source: string): string {
  let next = source;
  for (const pattern of MOBILE_FORBIDDEN_DECLARATIONS) {
    next = next.replace(pattern, (match, prefix: string) => prefix || '');
  }
  // Strip border shorthand color values (e.g. "border: 1px solid oklch(...)" -> "border: 1px solid")
  next = next.replace(
    /border\s*:\s*(\d+[a-z]*\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset))\s+(?:oklch|hsl|rgb|#)\([^)]*\)[^;]*/gmi,
    'border: $1',
  );
  next = next.replace(
    /border\s*:\s*(\d+[a-z]*\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset))\s+#[0-9a-fA-F]{3,8}\b/gmi,
    'border: $1',
  );
  return next.replace(/\n{3,}/g, '\n\n');
}

async function listMobileSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMobileSourceFiles(fullPath));
      continue;
    }
    const ext = extname(entry.name);
    if (ext === '.astro' || ext === '.css' || ext === '.tsx' || ext === '.ts') {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Post-process all .astro/.css files to fix common mobile drawer CSS bugs:
 * 1. If a `.mobile-nav` or similar drawer has `position: fixed` but no `transform: translateX(100%)`,
 *    add the hidden-by-default transform so the drawer starts off-screen.
 * 2. Remove `display: block` from backdrop elements inside media queries (they permanently block all taps).
 */
async function fixMobileDrawerCSS(workingDir: string): Promise<void> {
  const srcDir = join(workingDir, 'src');
  const files = await listMobileSourceFiles(srcDir);

  await Promise.all(files.map(async (file) => {
    const original = await readFile(file, 'utf-8');
    let repaired = original;

    // Fix 1: drawer base rule with position:fixed but no translateX — add off-screen default
    repaired = repaired.replace(
      /(\.(mobile-nav|nav-drawer|side-nav|mobile-menu)\s*\{)([^}]*position\s*:\s*fixed[^}]*)(\})/gms,
      (match, open, _cls, body, close) => {
        if (/transform\s*:/.test(body)) return match; // already has transform
        return `${open}${body}  transform: translateX(100%);\n${close}`;
      },
    );

    // Fix 2: .mobile-nav.is-open block missing transform: translateX(0) — add the reset
    // Handles both empty and non-empty .is-open blocks
    repaired = repaired.replace(
      /(\.(mobile-nav|nav-drawer|side-nav|mobile-menu)\.is-open\s*\{)([^}]*)(\})/gms,
      (match, open, _cls, body, close) => {
        if (/transform\s*:/.test(body)) return match; // already has transform reset
        return `${open}${body}  transform: translateX(0);\n${close}`;
      },
    );

    // Fix 3: .mobile-nav-backdrop.is-visible missing display override — add display:block
    // Without this, `display: none` on the base rule prevents the backdrop from ever showing
    repaired = repaired.replace(
      /(\.(mobile-nav-backdrop|nav-backdrop|drawer-backdrop)\.is-visible\s*\{)([^}]*)(\})/gms,
      (match, open, _cls, body, close) => {
        if (/\bdisplay\s*:/.test(body)) return match; // already has display
        return `${open}${body}  display: block;\n${close}`;
      },
    );

    // Fix 4: Remove unconditional `display: block` on backdrop inside @media (permanently blocks taps)
    repaired = repaired.replace(
      /(@media[^{]+\{[\s\S]*?)(\.mobile-nav-backdrop\s*\{[^}]*?)display\s*:\s*block\s*;([^}]*\})/gm,
      '$1$2$3',
    );

    if (repaired !== original) {
      await writeFile(file, repaired, 'utf-8');
    }
  }));
}

async function ensureMobileNavBehavior(workingDir: string): Promise<void> {
  const headerPath = join(workingDir, 'src/components/Header.astro');
  try {
    const source = await readFile(headerPath, 'utf-8');
    let repaired = source;
    if (!repaired.includes('class="nav-toggle"') && repaired.includes('main-nav')) {
      repaired = repaired.replace(/(<a href="#book-now-popup"[\s\S]*?<\/a>)/, `      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="mobile-nav" aria-label="Open navigation menu">\n        <span></span><span></span><span></span>\n      </button>\n\n$1`);
    }
    if (repaired.includes('class="main-nav"') && !repaired.includes('id="mobile-nav"')) {
      repaired = repaired.replace(/<nav([^>]*)class="([^"]*main-nav[^"]*)"([^>]*)>/, '<nav id="mobile-nav"$1class="$2"$3 hidden>');
    }
    if (!repaired.includes('nav-toggle')) {
      repaired = repaired.replace(/<style>/, `<style>\n  .nav-toggle { display: none; border: 1px solid; background: transparent; padding: 10px; border-radius: 8px; }\n  .nav-toggle span { display: block; width: 18px; height: 2px; background: currentColor; margin: 3px 0; }\n`);
    }
    if (!repaired.includes('mobile-nav')) {
      repaired = repaired.replace(/@media \(max-width: 961px\) \{/, `@media (max-width: 961px) {\n    .nav-toggle { display: inline-flex; flex-direction: column; justify-content: center; }\n    #mobile-nav[hidden] { display: none !important; }\n    #mobile-nav:not([hidden]) { display: flex; position: absolute; top: 100%; left: 0; right: 0; flex-direction: column; gap: 16px; padding: 16px 24px; border-top: 1px solid; }`);
    }
    if (!repaired.includes('aria-controls="mobile-nav"') && repaired.includes('<header')) {
      repaired = repaired.replace(/<\/style>/, `</style>\n\n<script>\n  const toggle = document.querySelector('.nav-toggle');\n  const nav = document.getElementById('mobile-nav');\n  if (toggle && nav) {\n    toggle.addEventListener('click', () => {\n      const expanded = toggle.getAttribute('aria-expanded') === 'true';\n      toggle.setAttribute('aria-expanded', String(!expanded));\n      if (expanded) nav.setAttribute('hidden', '');\n      else nav.removeAttribute('hidden');\n    });\n  }\n</script>`);
    }
    if (repaired !== source) {
      await writeFile(headerPath, repaired, 'utf-8');
    }
  } catch {
    // ignore missing header
  }
}
