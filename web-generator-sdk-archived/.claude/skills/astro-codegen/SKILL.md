---
name: astro-codegen
description: Generate Astro.js code (layouts, components, pages) from design briefs using Shadcn UI components. Use this skill when you need to create .astro files from a design-brief.json specification. Works with Shadcn Skill for component APIs, Frontend Design Skill for visual polish, and Astro AI Docs for best practices. Always use this skill when generating Astro code, creating .astro files, or implementing page layouts. The skill includes reference files for layout-specific, component-specific, and page-specific generation rules.
---

# Astro Code Generation

Generate Astro.js layouts, components, and pages from design briefs. This skill handles code generation with proper Shadcn UI integration.

## When to use this skill

Use this skill when you need to:
- Generate Astro .astro files from a design brief
- Create layouts, components, or pages
- Integrate Shadcn UI components
- Ensure proper Astro conventions

## Quick reference

| What you're generating | Reference file |
|------------------------|----------------|
| Layout component | `references/layout.md` |
| Reusable components | `references/components.md` |
| Page files | `references/pages.md` |
| Astro + Shadcn rules | `references/astro-conventions.md` |

## Your task

Generate .astro files based on the design-brief.json specification. Always:

1. Read the appropriate reference file for the file type you're generating
2. Use Shadcn Skill for correct component APIs
3. Use Frontend Design Skill for visual quality
4. Follow Astro conventions from the reference files
5. Write files to the correct location using Write tool

## File locations

| File type | Location |
|-----------|----------|
| Layouts | `src/layouts/Layout.astro` |
| Components | `src/components/ComponentName.astro` |
| Pages | `src/pages/page-name.astro` |
| UI components | `src/components/ui/` (via `bunx shadcn add`) |

## Important notes

- **ALWAYS read the reference file** before generating
- Use `@/` import paths for ui and lib
- Interactive Shadcn components need `client:load` or `client:visible`
- Static Shadcn components (Badge, Card) don't need client directive
- Install Shadcn components: `bunx shadcn add [component]`
- Import Layout in pages: `import Layout from '@/layouts/Layout.astro'`
- Wrap page content: `<Layout>...</Layout>`

## Design brief input

The skill expects `design-brief.json` with:

```json
{
  "pages": [{ "page": "index", "sections": [...] }],
  "sharedComponents": [{ "name": "Header", ... }],
  "designDirection": "..."
}
```

## Generation workflow

1. **Read design-brief.json** to understand what to generate
2. **Read the appropriate reference file** for generation rules
3. **Check if Shadcn components need installation** - run `bunx shadcn add`
4. **Generate the .astro file** following reference patterns
5. **Verify** the file uses correct imports and directives

## See references

- `references/layout.md` - Layout generation rules
- `references/components.md` - Component generation rules
- `references/pages.md` - Page generation rules
- `references/astro-conventions.md` - Astro + Shadcn integration