# Astro Template for Mecury

Fixed reference template used by Mecury to generate Astro projects.

## Tech Stack

- **Astro.js** v6 — Static site framework
- **React** v19 — Interactive components
- **Tailwind CSS** v4 — CSS-first configuration (no `tailwind.config.mjs`)
- **Shadcn UI** — Component library (configured, NOT pre-installed)
- **TypeScript** — Strict mode with `@/*` path aliases

## Project Structure

```
src/
├── components/
│   └── ui/                   # Shadcn UI components (installed during generation)
├── layouts/
│   └── Layout.astro          # Base HTML layout with <slot/>
├── lib/
│   ├── utils.ts              # cn() helper (clsx + tailwind-merge)
│   └── content.ts            # Content fetcher interface
├── pages/
│   └── index.astro           # Placeholder page
├── data/
│   └── content.json          # Empty; populated during Phase 1c (Seed)
└── styles/
    └── globals.css           # Tailwind v4 + OKLCH CSS variables
```

## Tailwind CSS v4 (CSS-First)

There is **no `tailwind.config.mjs`**. All theme configuration lives in `globals.css`:

- `@import "tailwindcss"` — loads Tailwind
- `@import "tw-animate-css"` — animation utilities
- `@custom-variant dark` — class-based dark mode
- `@theme inline { }` — maps CSS variables to Tailwind tokens
- `:root` / `.dark` — OKLCH color values (replaced by Phase 4)

## Shadcn UI

Components are **NOT pre-installed**. Install during generation:

```bash
bunx shadcn add button card dialog tabs navigation-menu ...
```

Config: `components.json` (style: new-york, Tailwind v4 mode)

## Pipeline Phase Ownership

| Phase | What it touches in globals.css |
|-------|-------------------------------|
| 2: Layout | Spacing variables only |
| 3: Design | Typography, surfaces |
| 4: Color | All `--*` color values in `:root` and `.dark` |
| 5: Motion | Transitions/animations |

## Development

```bash
bun install
bun run dev        # dev server
bun run build      # production build
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run knip       # unused code detection
```
