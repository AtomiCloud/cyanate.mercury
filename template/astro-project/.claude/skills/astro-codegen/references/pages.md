# Pages Reference

Rules for generating `src/pages/` .astro files.

## File structure

```astro
---
import Layout from '@/layouts/Layout.astro';
import Hero from '@/components/Hero.astro';

interface Props {
  // Page-specific props from content.json
}

const { } = Astro.props;
---

<Layout title="Page Title">
  <Hero heading="Welcome" />
  <main class="container mx-auto px-4 py-8">
    <!-- Page content -->
  </main>
</Layout>
```

## Requirements

1. **Import Layout**
   - Always: `import Layout from '@/layouts/Layout.astro';`

2. **Wrap in Layout component**
   - Page content must be wrapped: `<Layout>...</Layout>`
   - Pass title as prop: `<Layout title="Page Title">`

3. **Frontmatter**
   - Define Props interface for content data
   - Import any components used on the page

4. **Content mapping**
   - Map `design-brief.json` → `sections` to page sections
   - Use `{{field}}` syntax to reference content fields

## Page types

### Homepage (index.astro)
```astro
---
import Layout from '@/layouts/Layout.astro';
import HeroSection from '@/components/HeroSection.astro';
import FeatureGrid from '@/components/FeatureGrid.astro';
---

<Layout title="Home">
  <HeroSection
    heading="{{heading}}"
    subheading="{{subheading}}"
    cta={{ text: "{{cta}}", href: "/contact" }}
  />
  <FeatureGrid items="{{features}}" />
</Layout>
```

### About page
```astro
---
import Layout from '@/layouts/Layout.astro';
---

<Layout title="About">
  <main class="container mx-auto px-4 py-16">
    <h1 class="text-4xl font-bold mb-8">{{heading}}</h1>
    <div class="prose max-w-none">
      {{content}}
    </div>
  </main>
</Layout>
```

### Blog listing
```astro
---
import Layout from '@/layouts/Layout.astro';
import BlogCard from '@/components/BlogCard.astro';

const posts = [
  { title: "Post 1", excerpt: "...", slug: "post-1" },
  // ... mapped from {{posts}}
];
---

<Layout title="Blog">
  <main class="container mx-auto px-4 py-8">
    <h1 class="text-3xl font-bold mb-8">Blog</h1>
    <div class="grid gap-6">
      {posts.map((post) => (
        <BlogCard {...post} />
      ))}
    </div>
  </main>
</Layout>
```

### Blog post
```astro
---
import Layout from '@/layouts/Layout.astro';

const { title, content, author, date } = Astro.props;
---

<Layout title={title}>
  <article class="container mx-auto px-4 py-8 max-w-3xl">
    <header class="mb-8">
      <h1 class="text-4xl font-bold">{title}</h1>
      <p class="text-muted-foreground">
        By {author} · {new Date(date).toLocaleDateString()}
      </p>
    </header>
    <div class="prose prose-slate max-w-none">
      {content}
    </div>
  </article>
</Layout>
```

## Dynamic routes

For dynamic pages (blog posts, products):

```
src/pages/
├── blog/
│   ├── index.astro       # Listing
│   └── [slug].astro      # Dynamic post page
```

In `[slug].astro`:
```astro
---
import Layout from '@/layouts/Layout.astro';

const { slug } = Astro.params;
// Fetch post data by slug
---

<Layout title={post.title}>
  {/* Post content */}
</Layout>
```

## Section rendering

Each section from the design brief becomes a component or div:

```json
{
  "sections": [
    { "name": "hero", "layout": "text-center py-20", "components": ["Button"] },
    { "name": "features", "layout": "grid grid-cols-3 gap-6", "components": ["Card"] }
  ]
}
```

Rendered as:
```astro
<section class="text-center py-20">
  <h1>{{heading}}</h1>
  <Button>{{cta}}</Button>
</section>

<section class="grid grid-cols-3 gap-6">
  {{features.map(f => <Card>{f.title}</Card>)}}
</section>
```

## Content mapping patterns

| Content pattern | Rendering |
|----------------|------------|
| `{{heading}}` | `<h1>{heading}</h1>` |
| `{{items}}` | `items.map(item => <div>{item.title}</div>)` |
| `{{content}}` | `<div set:html={content} />` (for HTML) or `{content}` (for text) |
| `{{image}}` | `<img src={image.url} alt={image.alt} />` |

## Important notes

- Every page MUST import Layout
- Content MUST be wrapped in `<Layout>...</Layout>`
- Use semantic HTML (main, section, article, header, footer)
- Apply Tailwind classes from the design brief's layout field
- Map content.json fields using {{field}} syntax
