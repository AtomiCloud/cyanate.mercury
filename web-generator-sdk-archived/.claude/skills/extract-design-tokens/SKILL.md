---
name: extract-design-tokens
description: Extract design tokens (colors, typography, spacing, borders, shadows) from a reference website using headless browser automation. Use this skill when you need to scrape a website's visual design values and convert them to OKLCH format for Shadcn theming. Works with Webapp Testing Skill for Playwright automation and Shadcn Skill for CSS variable mapping. Always use this skill when the user mentions "extract design", "scrape styles", "get colors from website", "design tokens", or wants to clone/mimic a site's visual design.
---

# Extract Design Tokens

Extract visual design tokens from a reference website and output them as structured JSON with colors in OKLCH format for use with Shadcn theming.

## When to use this skill

Use this skill when you need to:
- Scrape design values from a live website
- Extract color palettes and convert to OKLCH
- Analyze typography, spacing, and other visual properties
- Create design token JSON for site generation

## Your task

1. **Write a Python Playwright script** that:
   - Launches headless browser
   - Visits the reference URL
   - Extracts computed styles from key elements
   - Outputs structured design tokens as JSON

2. **Extract these properties**:
   - **Colors**: Primary, secondary, accent, background, foreground, muted, border, destructive
   - **Typography**: Font families, font sizes, font weights
   - **Spacing**: Common spacing values (padding, margins, gaps)
   - **Border radius**: Values used on buttons, cards, etc.
   - **Shadows**: Box shadow values

3. **Output format** - Save as `design-tokens.json`:

```json
{
  "colors": {
    "primary": "#3b82f6",
    "primaryForeground": "#ffffff",
    "secondary": "#64748b",
    "accent": "#8b5cf6",
    "background": "#ffffff",
    "foreground": "#0f172a",
    "muted": "#f1f5f9",
    "mutedForeground": "#64748b",
    "border": "#e2e8f0",
    "input": "#e2e8f0",
    "ring": "#3b82f6",
    "destructive": "#ef4444",
    "destructiveForeground": "#ffffff",
    "card": "#ffffff",
    "cardForeground": "#0f172a",
    "popover": "#ffffff",
    "popoverForeground": "#0f172a"
  },
  "typography": {
    "fontFamily": {
      "sans": ["Inter", "system-ui", "sans-serif"],
      "mono": ["Fira Code", "monospace"]
    },
    "fontSize": {
      "xs": "0.75rem",
      "sm": "0.875rem",
      "base": "1rem",
      "lg": "1.125rem",
      "xl": "1.25rem",
      "2xl": "1.5rem",
      "3xl": "1.875rem",
      "4xl": "2.25rem"
    },
    "fontWeight": {
      "normal": 400,
      "medium": 500,
      "semibold": 600,
      "bold": 700
    }
  },
  "spacing": {
    "xs": "0.25rem",
    "sm": "0.5rem",
    "md": "1rem",
    "lg": "1.5rem",
    "xl": "2rem",
    "2xl": "3rem"
  },
  "borderRadius": {
    "sm": "0.25rem",
    "md": "0.375rem",
    "lg": "0.5rem",
    "xl": "0.75rem",
    "full": "9999px"
  },
  "shadows": {
    "sm": "0 1px 2px rgb(0 0 0 / 0.05)",
    "md": "0 4px 6px -1px rgb(0 0 0 / 0.1)",
    "lg": "0 10px 15px -3px rgb(0 0 0 / 0.1)",
    "xl": "0 20px 25px -5px rgb(0 0 0 / 0.1)"
  }
}
```

## How to extract

### Colors
Use `window.getComputedStyle()` on key elements:
- Buttons/CTAs → primary, accent
- Navigation text → foreground
- Page background → background
- Card backgrounds → card
- Borders → border
- Error states → destructive

```python
# Example extraction pattern
colors = page.evaluate("""
() => {
  const styles = {
    primary: getComputedStyle(document.querySelector('button, a[href]')).backgroundColor,
    background: getComputedStyle(document.body).backgroundColor,
    foreground: getComputedStyle(document.body).color,
    // ... more selectors
  };
  return styles;
}
""")
```

### Typography
- `fontFamily` from body, headings, buttons
- `fontSize` from h1-h6, p, span
- `fontWeight` from headings, buttons

### Spacing
- Measure `padding`, `margin`, `gap` on containers
- Cluster values into a scale (xs, sm, md, lg, xl, 2xl)

### Border radius
- Extract from buttons, cards, inputs
- Cluster into scale (sm, md, lg, xl, full)

### Shadows
- Extract `boxShadow` from elevated elements
- Create hierarchy (sm, md, lg, xl)

## Important notes

- **Use Webapp Testing Skill** for Playwright script patterns
- **Use Shadcn Skill** to understand CSS variable names and OKLCH conversion
- Colors in output can be hex/rgb (OKLCH conversion happens in next step)
- If no reference URL is provided, generate sensible defaults
- Run browser in headless mode (for Docker/Kubernetes deployment)
- Save output as `design-tokens.json` in the current directory

## Default tokens (when no URL provided)

If no reference URL is given, use these modern defaults:

```json
{
  "colors": {
    "primary": "#3b82f6",
    "primaryForeground": "#ffffff",
    "secondary": "#64748b",
    "accent": "#8b5cf6",
    "background": "#ffffff",
    "foreground": "#0f172a",
    "muted": "#f1f5f9",
    "mutedForeground": "#64748b",
    "border": "#e2e8f0",
    "destructive": "#ef4444"
  }
}
```