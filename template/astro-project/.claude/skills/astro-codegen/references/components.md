# Components Reference

Rules for generating `src/components/ComponentName.astro` files.

## File structure

```astro
---
// Props interface
interface Props {
  title?: string;
  items?: Array<{ title: string; description: string }>;
}

const { title, items = [] } = Astro.props;
---

<div class="container mx-auto px-4 py-8">
  <h2 class="text-3xl font-bold mb-6">{title}</h2>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    {items.map((item) => (
      <div class="p-6 border rounded-lg">
        <h3 class="font-semibold">{item.title}</h3>
        <p class="text-muted-foreground">{item.description}</p>
      </div>
    ))}
  </div>
</div>
```

## Shared components to generate

From `design-brief.json` → `sharedComponents` array:

### Header
```astro
---
const { title = "My Site" } = Astro.props;
const navigation = [
  { name: "Home", href: "/" },
  { name: "About", href: "/about" },
  { name: "Contact", href: "/contact" },
];
---

<header class="border-b">
  <div class="container mx-auto px-4 py-4 flex items-center justify-between">
    <a href="/" class="text-xl font-bold">{title}</a>
    <nav class="hidden md:flex gap-6">
      {navigation.map((item) => (
        <a href={item.href} class="text-muted-foreground hover:text-foreground">
          {item.name}
        </a>
      ))}
    </nav>
  </div>
</header>
```

### Footer
```astro
---
const currentYear = new Date().getFullYear();
---

<footer class="border-t py-8">
  <div class="container mx-auto px-4 text-center text-muted-foreground">
    <p>&copy; {currentYear} My Site. All rights reserved.</p>
  </div>
</footer>
```

### HeroSection
```astro
---
interface Props {
  heading?: string;
  subheading?: string;
  cta?: { text: string; href: string };
}

const { heading = "Welcome", subheading = "", cta } = Astro.props;
---

<section class="py-20 text-center">
  <div class="container mx-auto px-4">
    <h1 class="text-5xl font-bold mb-6">{heading}</h1>
    <p class="text-xl text-muted-foreground mb-8">{subheading}</p>
    {cta && (
      <a href={cta.href} class="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-primary-foreground hover:bg-primary/90">
        {cta.text}
      </a>
    )}
  </div>
</section>
```

## Props interface

Always define a TypeScript interface for props:

```typescript
interface Props {
  required: string;
  optional?: string;
  items?: Array<ItemType>;
}
```

## Shadcn component integration

When using Shadcn components:

```astro
---
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface Props {
  title: string;
}
---

<div>
  <Card>
    <h2>{title}</h2>
    <Button>Click me</Button>
  </Card>
</div>
```

## Client directives

For interactive Shadcn components, add client directive:

| Component | Directive |
|-----------|-----------|
| Dialog, Dropdown, Sheet, Tabs, Accordion, Command, Popover, HoverCard, Menubar, Select, Tooltip | `client:load` or `client:visible` |
| Badge, Card, Button (static) | No directive needed |

## Import paths

Always use `@/` alias:
- UI components: `@/components/ui/button`
- Custom components: `@/components/Header`
- Utils: `@/lib/utils`
- Layouts: `@/layouts/Layout`

## Design brief mapping

From `design-brief.json` → `sharedComponents`:

```json
{
  "name": "FeatureGrid",
  "description": "Grid of feature cards",
  "components": ["Card", "Badge"],
  "usedIn": ["index", "about"]
}
```

This generates `src/components/FeatureGrid.astro` using Card and Badge from Shadcn.
