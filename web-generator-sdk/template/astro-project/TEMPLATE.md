# Astro Template for web-generator-sdk

This is a **fixed reference template** used by the web-generator-sdk to generate Astro projects.

## Tech Stack

- **Astro.js** v6.0.3 - Static site framework
- **React** v19.2.4 - For interactive components
- **Tailwind CSS** v4.2.1 - Utility-first styling
- **TypeScript** - Type safety
- **Shadcn UI** - Component library (configured, NOT pre-installed)

## Project Structure

```
src/
├── components/
│   └── ui/                   # Shadcn UI components (installed during generation)
├── layouts/
│   └── Layout.astro         # Base HTML layout with <slot/>
├── lib/
│   └── utils.ts             # cn() helper for className merging
├── pages/
│   └── index.astro          # Placeholder page
└── styles/
    └── globals.css          # Tailwind + CSS variables (OKLCH format)
```

## Configuration Files

- `astro.config.mjs` - Astro with React and Tailwind integrations
- `tailwind.config.mjs` - Tailwind theme with CSS variable mapping
- `components.json` - Shadcn UI configuration
- `tsconfig.json` - TypeScript with path aliases (@/*)

## Design Tokens (CSS Variables)

The `globals.css` file uses OKLCH color format for all design tokens. During generation, these values are replaced with the extracted design tokens.

- Light mode and dark mode variables defined
- All colors use OKLCH format
- Border radius uses CSS variable

## Shadcn UI Components

**Components are NOT pre-installed.** During generation, install components as needed:

```bash
bunx shadcn add button card dialog tabs navigation-menu ...
```

This keeps the template lightweight and allows flexibility.

## Development

```bash
# Install dependencies (if needed)
bun install

# Start dev server
bun run dev

# Type check
bun run typecheck

# Build
bun run build

# Preview build
bun run preview
```

## Template Maintenance

When updating this template:
1. Test all changes locally
2. Verify type checking passes: `bun run typecheck`
3. Verify build succeeds: `bun run build`
4. Update this README if structure changes

## Generated Site Workflow

When web-generator-sdk creates a new site:

1. Copy this template to `projects/[site-name]/`
2. Replace CSS variables in `globals.css` with extracted design tokens
3. Install Shadcn components as needed: `bunx shadcn add [component]`
4. Generate pages/components based on scraped content
5. Run build and validate output
