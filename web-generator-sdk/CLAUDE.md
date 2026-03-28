# Web Generator SDK v2

AI-powered pipeline that redesigns an existing website to match the visual design of a reference site.

**Input:** Scraper output (structure.json, schema.json, content.json) from the original site — its pages, content, and navigation.
**Reference:** A target URL whose design we want to replicate (colors, typography, layout, motion, etc.).
**Output:** A complete Astro.js project with React, Tailwind v4, and Shadcn UI that has the original site's content but looks like the reference site.

## Pipeline

7 sequential phases, each owning a non-overlapping set of CSS/HTML properties. This layered approach prevents later phases from regressing earlier work.

| Phase | Step | Owns |
|-------|------|------|
| 0 | Analyze | Style fingerprint, 7-layer design tokens, component recipes |
| 1 | Structure | Content reduction, page classification, content collections |
| 2 | Layout | Grid/flex, spacing, responsive breakpoints (gray-box) |
| 3 | Design | Typography, component styling, surfaces (neutral palette) |
| 4 | Color | Color system, themes, WCAG contrast |
| 5 | Motion | Transitions, hover/focus states, scroll reveals |
| 6 | Polish | Validation, quality scoring, style fidelity |

Each phase runs an **implementer** agent that produces output, then parallel **reviewer** agents validate it. Rejection triggers a retry (max 3) with context passed back.

## Architecture

- `src/steps/` — One file per pipeline phase, each implements the step interface
- `src/pipeline/runner.ts` — Orchestrates the implementer+reviewer loop across phases
- `src/lib/agent.ts` — Claude Agent SDK wrapper with token tracking
- `src/lib/logger.ts` — TUI dashboard and verbose logging
- `src/types.ts` — All shared type definitions
- `template/astro-project/` — Base Astro template (React, Tailwind v4, Shadcn, Biome)
- `cui.json` — Config: input path, reference URL, env profile

## Key Patterns

- **Structured handoffs** between phases via JSON files, never truncated strings
- **Resume support** — can pick up from any previously completed step
- **Phase independence** — Phase N never touches properties owned by Phase <N
- Data between phases lives in a scratch/ directory within the run

## Tech Stack

Runtime: Bun · TypeScript
AI: Claude Agent SDK v0.2.76
Output: Astro v6 · React 19 · Tailwind CSS v4 · Shadcn UI · Biome
Colors: OKLCH format
Testing: Playwright
