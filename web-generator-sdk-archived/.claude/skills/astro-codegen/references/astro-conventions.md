# Astro + Shadcn Integration Conventions

Rules for integrating Shadcn UI components with Astro.

## Shadcn in Astro

Shadcn components are **React components** used inside `.astro` files.

### Installation

Shadcn components are installed during generation, not pre-installed:

```bash
bunx shadcn add button card dialog tabs navigation-menu
```

### Import syntax

```astro
---
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
---

<Button>Click me</Button>
<Card>
  <CardHeader>
    <CardContent>Content</CardContent>
  </CardHeader>
</Card>
```

## Client directives

Shadcn components that use React state/hooks need client directives:

### Interactive components (need `client:load` or `client:visible`)

| Component | Needs directive? | Directive |
|-----------|-----------------|-----------|
| Accordion | Yes | `client:load` |
| Alert | No | - |
| Alert Dialog | Yes | `client:load` |
| Aspect Ratio | No | - |
| Avatar | No | - |
| Badge | No | - |
| Breadcrumb | Yes | `client:visible` |
| Button (no onClick) | No | - |
| Button (onClick) | Yes | `client:load` |
| Calendar | Yes | `client:load` |
| Card | No | - |
| Carousel | Yes | `client:load` |
| Chart | Yes | `client:load` |
| Checkbox | Yes | `client:load` |
| Collapsible | Yes | `client:load` |
| Combobox | Yes | `client:load` |
| Command | Yes | `client:load` |
| Context Menu | Yes | `client:visible` |
| Data Table | Yes | `client:load` |
| Date Picker | Yes | `client:load` |
| Dialog | Yes | `client:load` |
| Drawer | Yes | `client:load` |
| Dropdown Menu | Yes | `client:visible` |
| Form | Yes | `client:load` |
| Hover Card | Yes | `client:visible` |
| Input | No | - |
| Label | No | - |
| Menubar | Yes | `client:load` |
| Navigation Menu | Yes | `client:load` |
| Popover | Yes | `client:visible` |
| Progress | No | - |
| Radio Group | Yes | `client:load` |
| Scroll Area | No | - |
| Select | Yes | `client:load` |
| Separator | No | - |
| Sheet | Yes | `client:load` |
| Skeleton | No | - |
| Slider | Yes | `client:load` |
| Sonner | Yes | `client:load` |
| Switch | Yes | `client:load` |
| Table | No | - |
| Tabs | Yes | `client:load` |
| Textarea | No | - |
| Toast | Yes | `client:load` |
| Toggle | Yes | `client:load` |
| Toggle Group | Yes | `client:load` |
| Tooltip | Yes | `client:visible` |

### Directive types

| Directive | When to use |
|-----------|-------------|
| `client:load` | Component needed immediately on page load |
| `client:visible` | Component can load when it enters viewport |
| `client:idle` | Component can load during browser idle time |

Example:
```astro
<Dialog>
  <DialogTrigger>Open</DialogTrigger>
  <DialogContent client:load>
    Content here
  </DialogContent>
</Dialog>
```

## Import paths

Always use `@/` path alias:

```astro
---
// ✅ Correct
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Layout from '@/layouts/Layout.astro';

// ❌ Wrong - don't use relative paths for ui/lib
import { Button } from '../../components/ui/button';
---
```

## Path aliases (tsconfig.json)

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

## Component composition

Shadcn components use composition:

```astro
---
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
---

<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description</CardDescription>
  </CardHeader>
  <CardContent>
    <p>Card content</p>
    <Button>Action</Button>
  </CardContent>
</Card>
```

## Utility function

The `cn()` function combines Tailwind classes:

```astro
---
import { cn } from '@/lib/utils';
---

<div class={cn("base-class", condition && "conditional-class")} />
```

## Styling with design tokens

Use Tailwind classes that map to CSS variables:

| Tailwind class | CSS variable |
|----------------|--------------|
| `bg-background` | `--background` |
| `text-foreground` | `--foreground` |
| `bg-primary` | `--primary` |
| `text-primary-foreground` | `--primary-foreground` |
| `bg-muted` | `--muted` |
| `text-muted-foreground` | `--muted-foreground` |
| `border-border` | `--border` |
| `ring-ring` | `--ring` |

## globals.css structure

```css
@import "tailwindcss";

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.15 0.02 270);
  /* ... all CSS variables */
}

.dark {
  --background: oklch(0.15 0.02 270);
  /* ... dark mode overrides */
}
```

## Common mistakes to avoid

❌ **Don't** use inline styles with raw colors:
```astro
<div style="color: #3b82f6">Wrong</div>
```

✅ **Do** use Tailwind classes with semantic tokens:
```astro
<div class="text-primary">Correct</div>
```

❌ **Don't** use arbitrary Tailwind values:
```astro
<div class="bg-[#3b82f6]">Wrong</div>
```

✅ **Do** map to semantic tokens:
```astro
<div class="bg-primary">Correct</div>
```

❌ **Don't** forget client directive on interactive components:
```astro
<Dialog>Won't work properly</Dialog>
```

✅ **Do** add client directive:
```astro
<Dialog client:load>Works properly</Dialog>
```