# Layout Reference

Rules for generating `src/layouts/Layout.astro` files.

## File structure

```astro
---
import '../styles/globals.css';

interface Props {
  title?: string;
  description?: string;
}

const {
  title = 'Generated Site',
  description = 'Site generated with web-generator-sdk',
} = Astro.props;
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content={description} />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
  </head>
  <body class="min-h-screen bg-background text-foreground antialiased">
    <Header />
    <main class="min-h-screen">
      <slot />
    </main>
    <Footer />
  </body>
</html>
```

## Requirements

1. **Imports**
   - Must import globals.css: `import '../styles/globals.css';`
   - Import shared components: `import Header from '@/components/Header.astro';`
   - Import Footer if present

2. **Props interface**
   - `title?: string` - Page title
   - `description?: string` - Meta description

3. **HTML structure**
   - `<!DOCTYPE html>` declaration
   - `<html lang="en">` root element
   - `<head>` with meta tags
   - `<body>` with Tailwind classes
   - `<slot />` for page content injection

4. **Body classes** (required)
   - `min-h-screen bg-background text-foreground antialiased`

5. **Shared components**
   - Include Header component (if in sharedComponents)
   - Include Footer component (if in sharedComponents)
   - Wrap slot in `<main>` for semantics

## Meta tags

Always include:
- `<meta charset="UTF-8" />`
- `<meta name="description" content={description} />`
- `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`
- `<title>{title}</title>`

## Design brief mapping

From `design-brief.json`:
- `sharedComponents` - determines which shared components to include
- `designDirection` - influences overall layout approach

## Common patterns

| Pattern | Code |
|---------|------|
| With Header/Footer | `<Header /><main><slot /></main><Footer />` |
| Minimal (no shared) | `<main><slot /></main>` |
| With navigation | `<NavigationMenu client:load />` |
| Dark mode support | Add `class="dark"` to html element if needed |