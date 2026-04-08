# Quality Checklist

Evaluation criteria for visual quality assessment of generated websites.

## Scoring rubric

Each dimension is scored 1-10:
- **9-10**: Excellent, exceeds expectations
- **7-8**: Good, meets requirements
- **5-6**: Acceptable, minor issues
- **3-4**: Poor, significant issues
- **1-2**: Fails, needs re-generation

## Dimensions

### 1. Layout Consistency (9-10 = Excellent)

Does the layout match the design brief sections?

| Score | Criteria |
|-------|----------|
| 9-10 | All sections from brief present, correct layout classes, proper section ordering |
| 7-8 | Most sections present, minor layout deviations |
| 5-6 | Some sections missing or wrong layout |
| 3-4 | Major layout issues, sections in wrong order |
| 1-2 | Layout doesn't match brief at all |

**What to check:**
- Hero section at top?
- Features grid has correct number of columns?
- CTA section present?
- Section ordering matches brief?

### 2. Design Token Usage (9-10 = Excellent)

Are semantic CSS variables applied correctly?

| Score | Criteria |
|-------|----------|
| 9-10 | All colors use semantic tokens (bg-primary, text-foreground), no raw colors |
| 7-8 | Mostly semantic tokens, 1-2 minor raw color usages |
| 5-6 | Mix of semantic and raw colors |
| 3-4 | Mostly raw colors |
| 1-2 | No semantic tokens used, all raw colors |

**What to check:**
- No `bg-[#...]` arbitrary colors
- No inline `style="color: #..."`
- Uses `bg-background`, `text-foreground`, `bg-primary`, etc.
- OKLCH values present in globals.css

### 3. Component Composition (9-10 = Excellent)

Are Shadcn components used as specified in design brief?

| Score | Criteria |
|-------|----------|
| 9-10 | All specified Shadcn components used correctly, proper composition |
| 7-8 | Most components used, minor composition issues |
| 5-6 | Some components missing or wrong |
| 3-4 | Many components not used or wrong |
| 1-2 | Components don't match brief |

**What to check:**
- Card component used for feature cards?
- Button used for CTAs?
- Correct component composition (Card > CardHeader > CardTitle)?
- Client directives on interactive components?

### 4. Responsive Design (9-10 = Excellent)

Are responsive breakpoints handled correctly?

| Score | Criteria |
|-------|----------|
| 9-10 | Works perfectly on mobile, tablet, desktop; proper breakpoints |
| 7-8 | Good responsive, minor spacing issues on one breakpoint |
| 5-6 | Basic responsive, breaks on one screen size |
| 3-4 | Poor responsive, breaks on multiple sizes |
| 1-2 | Not responsive at all |

**What to check:**
- Mobile (375px): readable, no horizontal scroll
- Tablet (768px): proper grid collapse
- Desktop (1920px): content not too wide
- Touch targets ≥ 44x44px

### 5. Semantic HTML (9-10 = Excellent)

Is the HTML structure semantic and accessible?

| Score | Criteria |
|-------|----------|
| 9-10 | Proper semantic tags (header, nav, main, section, article, footer) |
| 7-8 | Mostly semantic, minor divitis |
| 5-6 | Some semantic tags, but excessive divs |
| 3-4 | Minimal semantic structure |
| 1-2 | No semantic tags, all divs |

**What to check:**
- `<header>`, `<nav>`, `<main>`, `<footer>` used?
- `<h1>-<h6>` in correct order?
- `<article>` for blog posts?
- `<section>` for content sections?
- Alt text on images?
- ARIA labels where needed?

### 6. Visual Appeal (9-10 = Excellent)

Does it look polished and intentional?

| Score | Criteria |
|-------|----------|
| 9-10 | Polished, distinctive, not generic, good whitespace |
| 7-8 | Good looking, somewhat distinctive |
| 5-6 | Acceptable, somewhat generic |
| 3-4 | Poor, looks like a template |
| 1-2 | Broken, ugly, or incomplete |

**What to check:**
- Good spacing/whitespace?
- Typography hierarchy (sizes, weights)?
- Color harmony?
- Not "cookie-cutter" Shadcn default look?
- Intentional design decisions?

## Overall score calculation

```javascript
overallScore = (
  layoutConsistency * 1.5 +
  designTokenUsage * 1.5 +
  componentComposition * 1.0 +
  responsiveDesign * 1.0 +
  semanticHTML * 1.0 +
  visualAppeal * 1.0
) / 7
```

Weighted toward layout consistency and design token usage (most critical).

## Pass/fail threshold

- **Pass**: overallScore ≥ 7.0
- **Marginal**: 6.0 ≤ overallScore < 7.0 (flag for review)
- **Fail**: overallScore < 6.0 (trigger iterate-and-fix)

## Common issues that lower scores

### Layout consistency
- Missing sections from brief
- Wrong grid columns (3 instead of 4)
- Sections in wrong order

### Design token usage
- `bg-[#3b82f6]` instead of `bg-primary`
- `style="color: #fff"` instead of `text-primary-foreground`
- Unused globals.css variables

### Component composition
- Missing `client:load` on Dialog
- Card without CardHeader wrapper
- Wrong prop names

### Responsive design
- No mobile breakpoint classes
- Grid doesn't collapse
- Text too small on mobile
- Horizontal scroll on mobile

### Semantic HTML
- `<div class="header">` instead of `<header>`
- `<div class="button">` instead of `<button>`
- Missing alt attributes
- No heading hierarchy

### Visual appeal
- Default Shadcn styling unchanged
- Too little or too much whitespace
- Inconsistent spacing
- Generic "Bootstrap site" look