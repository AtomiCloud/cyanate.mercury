---
name: design-brief
description: Generate a comprehensive design brief for Astro.js website generation from scraper output and design tokens. Use this skill when you have scraped website data (structure.json, schema.json, content.json) and design tokens, and need to create a section-by-section blueprint for each page. Works with Shadcn Skill to understand available components and composition patterns. Always use this skill when the user mentions "design brief", "site blueprint", "page planning", "component mapping", or needs to bridge scraped content to code generation.
---

# Design Brief

Generate a comprehensive design brief that bridges scraped website content to Astro.js code generation. The brief defines page structure, sections, components, and content mapping.

## When to use this skill

Use this skill when you have:
- Scraper output (structure.json, schema.json, content.json)
- Extracted design tokens (design-tokens.json)
- Need to plan page layouts and component usage

## Your task

Generate a `design-brief.json` file that serves as a blueprint for code generation.

## Output structure

Save as `design-brief.json`:

```json
{
  "pages": [
    {
      "page": "index",
      "pageType": "homepage",
      "title": "Home",
      "sections": [
        {
          "name": "hero",
          "layout": "full-width, max-w-7xl mx-auto, text-center py-20",
          "components": ["Button", "Badge"],
          "content": {
            "heading": "Welcome to Our Site",
            "subheading": "Build amazing things",
            "cta": "Get Started"
          }
        }
      ]
    }
  ],
  "sharedComponents": [
    {
      "name": "Header",
      "description": "Site navigation with logo and menu",
      "components": ["NavigationMenu"],
      "usedIn": ["index", "about", "contact"]
    },
    {
      "name": "Footer",
      "description": "Site footer with links",
      "components": [],
      "usedIn": ["index", "about", "contact"]
    }
  ],
  "designDirection": "Modern, clean interface with emphasis on content hierarchy and whitespace"
}
```

## How to generate the brief

### 1. Analyze the structure

From `structure.json`:
- List all page types (homepage, about, blog-listing, blog-post, etc.)
- Note navigation hierarchy
- Identify shared elements across pages

### 2. Analyze the schema

From `schema.json`:
- Understand content fields per page type
- Note required vs optional fields
- Identify content relationships

### 3. Analyze content samples

From `content.json`:
- Review 5 sample pages per type
- Identify common section patterns
- Map content to potential UI components

### 4. Define sections per page

For each page type, define sections with:

| Field | Description |
|-------|-------------|
| `name` | Section identifier (hero, features, testimonials, cta) |
| `layout` | Tailwind layout description |
| `components` | Shadcn components to use (from Shadcn Skill knowledge) |
| `content` | Mapped content fields from content.json |

### 5. Define shared components

Components used across multiple pages:
- **Header** - Navigation, logo
- **Footer** - Links, copyright
- **HeroSection** - Landing page hero
- **FeatureGrid** - Feature displays
- **TestimonialCard** - Customer quotes

### 6. Design direction

Describe the overall aesthetic approach based on:
- Design token values (color personality, typography tone)
- Content type (professional, playful, minimal)
- Reference site patterns (if available)

## Section patterns

Common section types to recognize:

| Section | Typical Layout | Shadcn Components |
|---------|---------------|-------------------|
| Hero | Centered, large heading, CTA | Button, Badge |
| Features | Grid of 3 items | Card |
| Testimonials | Grid or carousel | Card, Avatar |
| Pricing | 3-column comparison | Card, Button, Badge |
| CTA | Full-width band | Button |
| Content | Text + media | - |
| Form | Vertical stack | Input, Button, Label |

## Important notes

- **Use Shadcn Skill** to know available components and their APIs
- Sections should be reusable across page types
- Map content.json fields directly to section content
- Keep layouts responsive (mobile-first approach)
- Specify `client:load` for interactive Shadcn components
- The brief drives the astro-codegen skill - be specific

## Content mapping

Map content.json fields to section content:

```json
{
  "content": {
    "title": "{{heading}}",
    "description": "{{subheading}}",
    "items": "{{features}}",
    "link": "{{ctaUrl}}"
  }
}
```

Use `{{field}}` syntax to reference content.json fields.