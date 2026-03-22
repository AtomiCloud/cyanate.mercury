# Common Error Patterns and Auto-Fixes

Known error patterns in generated Astro code and how to fix them.

## Auto-fixable violations

| Violation | Pattern | Fix |
|-----------|---------|-----|
| `{tokens.colors.primary}` in CSS | `color: {tokens.colors.primary}` | Replace with `bg-primary` or `text-primary` class |
| Missing Layout import | Page without `import Layout` | Add: `import Layout from '@/layouts/Layout.astro';` |
| Content not in Layout | Content outside `<Layout>` | Wrap: `<Layout>...</Layout>` |
| HTML in component | `<html><body>` in `.astro` component | Strip HTML/body, keep inner content |
| Relative UI import | `import from '../../components/ui'` | Rewrite to `@/components/ui/[name]` |
| Missing client directive | `<Dialog>` without `client:load` | Add `client:load` or `client:visible` |
| Raw hex in Tailwind | `bg-[#3b82f6]` | Map to semantic: `bg-primary` |
| Inline style color | `style="color: #3b82f6"` | Use class: `text-primary` |

## Fix procedures

### 1. Unreplaced template tokens

**Pattern:** `{tokens.colors.primary}`, `{theme.spacing.md}`, etc.

**Fix:**
```astro
<!-- Before -->
<div style="color: {tokens.colors.primary}">Text</div>

<!-- After -->
<div class="text-primary">Text</div>
```

### 2. Missing Layout import in pages

**Pattern:** Page file doesn't import Layout

**Fix:**
```astro
---
// Add at top of frontmatter
import Layout from '@/layouts/Layout.astro';
---
```

### 3. Content not wrapped in Layout

**Pattern:** Content in page but no Layout wrapper

**Fix:**
```astro
<!-- Before -->
---
import Layout from '@/layouts/Layout.astro';
---
<h1>Title</h1>

<!-- After -->
---
import Layout from '@/layouts/Layout.astro';
---
<Layout title="Title">
  <h1>Title</h1>
</Layout>
```

### 4. HTML/body tags in components

**Pattern:** `<html>`, `<head>`, `<body>` in component files

**Fix:** Remove HTML shell, keep only inner content

```astro
<!-- Before (component) -->
---
---
<!DOCTYPE html>
<html>
<body>
  <div>Content</div>
</body>
</html>

<!-- After (component) -->
---
---
<div>Content</div>
```

Note: Layout component SHOULD have HTML shell.

### 5. Relative import for UI components

**Pattern:** `import Button from '../../../components/ui/button'`

**Fix:**
```astro
---
// Before
import Button from '../../../components/ui/button';

// After
import { Button } from '@/components/ui/button';
---
```

### 6. Missing client directive on interactive components

**Pattern:** `<Dialog>`, `<Select>`, etc. without client directive

**Fix:**
```astro
<!-- Before -->
<Dialog>
  <DialogContent>...</DialogContent>
</Dialog>

<!-- After -->
<Dialog>
  <DialogContent client:load>...</DialogContent>
</Dialog>
```

### 7. Arbitrary Tailwind color values

**Pattern:** `bg-[#3b82f6]`, `text-[#ef4444]`

**Fix:** Map to semantic token class

```astro
<!-- Before -->
<div class="bg-[#3b82f6] text-white">Button</div>

<!-- After -->
<Button class="bg-primary text-primary-foreground">Button</div>
```

### 8. Inline styles with colors

**Pattern:** `style="color: #3b82f6"`, `style="background: white"`

**Fix:**
```astro
<!-- Before -->
<div style="color: #3b82f6">Text</div>
<div style="background: white">Card</div>

<!-- After -->
<div class="text-primary">Text</div>
<div class="bg-background">Card</div>
```

## Detection patterns

### Unreplaced tokens
```
\{tokens\.colors\.\w+\}
\{theme\.\w+\.\w+\}
\{spacing\.\w+\}
```

### Arbitrary Tailwind colors
```
bg-\[#.+\]
text-\[#.+\]
border-\[#.+\]
```

### Inline styles with colors
```
style="[^"]*color:\s*#[0-9a-f]+
style="[^"]*background:\s*#[0-9a-f]+
style="[^"]*backgroundColor:\s*#[0-9a-f]+
```

## Non-auto-fixable issues

These require manual review or re-generation:

- Complex component interactions not working
- Wrong component used for the purpose
- Layout breaking on responsive
- Content not mapping correctly
- Design not matching brief

Flag these for human review or trigger iterate-and-fix skill.

## Verification

After applying fixes, re-run:

```bash
bunx astro check
bun run typecheck
bun run build
```

All must pass for validation to be complete.
