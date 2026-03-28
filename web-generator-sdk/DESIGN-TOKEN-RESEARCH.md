# Design Token Extraction: Research & Architecture

## Current State

The current extraction captures **flat atomic tokens** — individual CSS values in isolation:
- Colors (primary, secondary, accent, background, foreground, muted, border, destructive)
- Typography (font families, sizes, weights)
- Spacing (xs→2xl scale)
- Border radius (sm→full scale)
- Shadows (sm→xl scale)

**The problem:** Two sites with identical color palettes and fonts can look completely different. A `#3b82f6` button isn't just a blue button — it's the specific combination of `padding: 8px 20px` + `font-weight: 600` + `letter-spacing: -0.01em` + `border-radius: 9999px` + `transition: all 150ms ease` + `hover: translateY(-1px)` that makes it feel like *that site's* button.

---

## Proposed: 7-Layer Token Architecture

```
Layer 0 — Atomic Tokens        (existing)
Layer 1 — Gradients & Surfaces  (new)
Layer 2 — Layout & Rhythm       (new)
Layer 3 — Component Recipes     (new)
Layer 4 — Interaction States    (new)
Layer 5 — Motion & Easing       (new)
Layer 6 — Visual Identity       (new)
```

---

### Layer 0 — Atomic Tokens (existing)

What we already extract: colors, typography, spacing, border-radius, shadows. These are the raw materials.

### Layer 1 — Gradients & Surfaces (new)

| Token | Example | Why it matters |
|-------|---------|---------------|
| Linear/radial/mesh gradients | `linear-gradient(135deg, primary, secondary)` | Stripe, Vercel use gradients as core aesthetic |
| Glass/blur effects | `backdrop-filter: blur(12px)` + semi-transparent bg | Apple, Linear — creates depth hierarchy |
| Texture/noise | SVG `feTurbulence` with frequency/octaves/opacity | Prevents flat, sterile surfaces |
| Image treatment | aspect-ratio, object-fit, overlay gradients | Brand-consistent media presentation |

**Gradients:**
- Linear gradients — direction (angle/keywords), color stops with positions, color space interpolation (OKLCH for perceptual smoothness)
- Radial gradients — shape (circle/ellipse), position, color stops
- Mesh gradients — Stripe's iconic animated background uses WebGL (MiniGL), GPU-accelerated noise functions and custom shaders
- Layered backgrounds — multiple `background-image` values stacked with transparency

**Glass/Blur Effects (Glassmorphism):**
- `backdrop-filter` blur values — optimal range 8-16px (below 5px barely frosted, above 25px opaque)
- Semi-transparent backgrounds — `rgba(255, 255, 255, 0.25)` light, `rgba(17, 25, 40, 0.75)` dark
- Light borders on glass — `1px solid rgba(255, 255, 255, 0.2)` for edge highlight
- Apple HIG vibrancy levels — materials from "ultra thin" to "ultra thick"
- Liquid Glass (iOS 26) — SVG displacement maps, `mask-image`, `mix-blend-mode`
- Performance: limit to key UI elements (headers, cards, modals), don't stack multiple blurred elements

**Texture/Pattern:**
- SVG noise texture via `<feTurbulence>` filter:
  - `baseFrequency`: 0.1-0.3 = larger/softer, 0.6-1.0 = finer/grainier
  - `numOctaves`: 1 = simple, 3-4 = natural detail
  - `type`: `fractalNoise` for cloudy/smooth, `turbulence` for ripple/liquid
- Opacity: 5-20% for subtle, 40-80% for pronounced
- Applied via `::before` pseudo-element with SVG as data URI, absolute positioned, ~0.08-0.12 opacity
- 2026 trend: "Strategic imperfection" — grain, sketchy lines as counter to AI-polished surfaces

**Image Treatment:**
- Border-radius patterns — card headers (top corners), avatars (full circle), `corner-shape: squircle` for Apple-style
- Object-fit — `cover` for visual impact, `contain` for full visibility
- Aspect ratio tokens — `1/1` (avatars), `16/9` (hero), `4/3` (cards), `3/2` (thumbnails)
- Image overlay gradients — `linear-gradient(transparent 40%, rgba(0,0,0,0.7))` for text readability
- Elevation tiers — named levels from shadow/low to elevation/modal

**Recommended token structure:**
```json
{
  "gradients": {
    "hero-primary": {
      "type": "linear",
      "angle": "135deg",
      "stops": [
        { "color": "{color.brand.primary}", "position": "0%" },
        { "color": "{color.brand.secondary}", "position": "100%" }
      ],
      "colorSpace": "oklch"
    }
  },
  "glass": {
    "panel": {
      "background": "rgba(255, 255, 255, 0.25)",
      "backdropBlur": "12px",
      "borderColor": "rgba(255, 255, 255, 0.2)",
      "borderWidth": "1px",
      "shadow": "0 4px 10px rgba(0, 0, 0, 0.15)"
    }
  },
  "texture": {
    "grain-subtle": {
      "type": "noise",
      "noiseType": "fractalNoise",
      "baseFrequency": 0.65,
      "numOctaves": 3,
      "opacity": 0.08,
      "blendMode": "overlay"
    }
  },
  "imageTreatment": {
    "card": { "borderRadius": "{radius.lg}", "aspectRatio": "16/9", "objectFit": "cover" },
    "avatar": { "borderRadius": "9999px", "aspectRatio": "1/1", "objectFit": "cover" }
  }
}
```

---

### Layer 2 — Layout & Rhythm (new)

| Token | Example | Why it matters |
|-------|---------|---------------|
| Grid usage patterns | Column counts, gutter values, span patterns | Not "12-col grid" but *how* it's actually used |
| Container variants | narrow (720px), default (1200px), wide (1440px) | Text content vs full-bleed sections |
| Section rhythm | Hero: 96px/80px, Default: 80px/64px, Compact: 48px/40px | Different section types have different padding |
| Breakpoint behavior | What *changes* at each breakpoint | Navigation collapse, grid shifts, spacing changes |
| Density mode | comfortable / compact / spacious | Same design, completely different feel |
| Component spacing vocabulary | inset, insetSquish, insetStretch, stack, inline, grid | How components own internal space (EightShapes) |

**Grid System:**
- `grid.columns` — actual column counts used (12 main, 3 features, 2 split)
- `grid.gutter` — gap between columns, often responsive (`{xs: 8, sm: 16, md: 24, lg: 32}`)
- `grid.rowGap` — vertical gap (often different from column gutter)
- `grid.columnSpans` — common span patterns

**Container Patterns:**
- `container.maxWidth` — per-breakpoint (sm: 640, md: 768, lg: 1024, xl: 1280, 2xl: 1536)
- `container.padding` — horizontal padding inside container, responsive
- `container.variants` — narrow (~60ch/720px for text), wide (full-bleed), standard

**Section Rhythm:**
- `section.padding.hero` — hero sections: 80-120px
- `section.padding.default` — standard sections: 64-80px desktop, 40-48px mobile
- `section.padding.compact` — CTAs/banners: 32-48px
- `section.padding.asymmetry` — many sites use more top than bottom
- Heading margins should be asymmetric — bottom smaller than top so headings connect to their content

**Breakpoint Strategy:**
- Capture what *changes* at each breakpoint, not just pixel values:
  - Layout shifts (1-col → 2-col → 3-col)
  - Container padding changes
  - Typography scale adjustments
  - Navigation pattern changes (hamburger vs full nav)

**Vertical Rhythm:**
- `rhythm.baseUnit` — fundamental unit (usually 4px or 8px)
- `rhythm.lineHeight.body` — base (usually 1.5 or 24px for 16px text)
- `rhythm.lineHeight.heading` — usually 1.2-1.3
- `rhythm.paragraphSpacing` — typically 1x-1.5x line-height
- `rhythm.headingSpacing.above` — 2x-3x base unit
- `rhythm.headingSpacing.below` — 1x-1.5x base unit (always less than above)

**Density Modes:**
- Cloudscape (AWS): "comfortable" (readability) and "compact" (data-dense)
- Gmail: Compact, Cozy, Comfortable
- Compact interfaces: 4-8-12px grid, 13-14px body text
- Airy interfaces: 16-24-32px grid, 16-18px body text

**Component Spacing Vocabulary (EightShapes):**
- `space.inset` — equal padding on all 4 sides (cards, containers, modals)
- `space.insetSquish` — compressed vertical (buttons, pills, badges) — `{top: 8, right: 16, bottom: 8, left: 16}`
- `space.insetStretch` — stretched vertical (text inputs, textareas) — `{top: 16, right: 12, bottom: 16, left: 12}`
- `space.stack` — vertical spacing between stacked elements
- `space.inline` — horizontal spacing between inline elements (tags, breadcrumbs)
- `space.grid` — spacing between grid items

**Key rule:** Components own internal spacing (padding, gaps). External spacing (margins between components) is controlled by parent layout, not the component itself.

**Recommended token structure:**
```json
{
  "layout": {
    "grid": {
      "columns": { "default": 12, "features": 3, "splitContent": 2 },
      "gutter": { "mobile": "16px", "tablet": "24px", "desktop": "32px" },
      "rowGap": { "mobile": "16px", "tablet": "24px", "desktop": "32px" }
    },
    "container": {
      "maxWidth": { "narrow": "720px", "default": "1200px", "wide": "1440px" },
      "padding": { "mobile": "16px", "tablet": "32px", "desktop": "64px" }
    },
    "breakpoints": {
      "sm": "640px", "md": "768px", "lg": "1024px", "xl": "1280px", "2xl": "1536px"
    }
  },
  "rhythm": {
    "baseUnit": "8px",
    "verticalRhythm": {
      "paragraphSpacing": "24px",
      "headingSpaceAbove": "48px",
      "headingSpaceBelow": "16px"
    }
  },
  "sections": {
    "padding": {
      "hero": { "top": "96px", "bottom": "80px" },
      "default": { "top": "80px", "bottom": "64px" },
      "compact": { "top": "48px", "bottom": "40px" }
    }
  },
  "density": { "mode": "comfortable", "scale": 1.0 },
  "componentSpacing": {
    "inset": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px" },
    "insetSquish": { "sm": "4px 8px", "md": "8px 16px", "lg": "12px 24px" },
    "insetStretch": { "sm": "12px 8px", "md": "16px 12px", "lg": "24px 16px" },
    "stack": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px", "xxl": "64px" },
    "inline": { "xs": "4px", "sm": "8px", "md": "12px", "lg": "16px" },
    "grid": { "sm": "16px", "md": "24px", "lg": "32px" }
  }
}
```

---

### Layer 3 — Component Recipes (new)

The biggest gap. Each component is a *recipe* — a named bundle of properties, not just individual tokens.

**Three-tier token architecture (industry standard):**

| Tier | Material Design 3 | Primer (GitHub) | Polaris (Shopify) |
|------|-------------------|-----------------|-------------------|
| Primitive | `md.ref.palette.primary40` | Base color scales (0-13) | Primitive tokens |
| Semantic | `md.sys.color.primary` | `fgColor`, `bgColor` | `--p-color-bg-surface` |
| Component | `md.comp.fab.container.color` | Pattern tokens | `space-card-padding` |

Material Design 3: **141 system tokens** + **800+ component tokens**. System tokens handle 80%, component tokens the remaining 20%.

**Button Recipes:**
- **Shape properties** (stable across variants): padding, radius, font-weight, height, letter-spacing, text-transform
- **Surface properties** (vary by variant): background, border, shadow, text-color
- **State properties**: hover, focus, active, disabled transforms
- **Variants**: default/primary (solid fill), secondary/outline (bordered), ghost (text-only), destructive (red), link, icon

**Card Patterns:**
- Elevated — layered `box-shadow`, no border (Material's 5-level system)
- Outlined — `1px solid` border, no shadow
- Filled — distinct background color
- Hover: `translateY(-2px)` + shadow increase (common lift pattern)

**Navigation Patterns:**
- Sticky nav with blur: `position: sticky; backdrop-filter: blur(10px); rgba(255,255,255,0.8)`
- Mobile menu: slide drawer (`translateX(-100%)`), full-screen overlay, bottom sheet
- Active state indicators: underline, background highlight, accent bar, dot indicator

**Form Styling:**
- Input height: commonly 36-44px (matching button height)
- Label position: above (most common), floating (Material), inline
- Focus ring: `:focus-visible` with `ring-2` (WCAG 2.2 requirement)
- Error states: red border + label + message below input

**Iconography:**
- Styles: outlined/stroke (SaaS), filled/solid (active states), duotone (expressive)
- Stroke width: tied to typography weight, common 1-2px, must be consistent
- Size scale: base 24x24, stops at 16, 20, 24, 32, 48
- Rule: never mix outlined and filled in same context; use filled for active/selected

**Recommended token structure:**
```json
{
  "button": {
    "base": {
      "paddingX": "20px",
      "paddingY": "8px",
      "fontWeight": "600",
      "borderRadius": "9999px",
      "fontSize": "14px",
      "transition": "all 150ms ease"
    },
    "variants": {
      "primary": { "bg": "token:primary", "color": "token:on-primary", "shadow": "sm" },
      "secondary": { "bg": "transparent", "border": "1px solid token:border", "color": "token:text" },
      "ghost": { "bg": "transparent", "color": "token:text" }
    },
    "states": {
      "hover": { "transform": "translateY(-1px)", "shadow": "md" },
      "focus": { "ring": "2px token:focus-ring" },
      "disabled": { "opacity": "0.5", "cursor": "not-allowed" }
    }
  },
  "card": {
    "variants": {
      "elevated": { "shadow": "md", "border": "none" },
      "outlined": { "border": "1px solid token:border", "shadow": "none" },
      "filled": { "bg": "token:muted", "border": "none", "shadow": "none" }
    },
    "padding": "24px",
    "hover": { "transform": "translateY(-2px)" }
  }
}
```

---

### Layer 4 — Interaction States (new)

| State | What to capture | Example |
|-------|----------------|---------|
| Hover | bg shift, elevation delta, translateY | `translateY(-1px)` + shadow lift |
| Focus | ring width/offset/color (WCAG 3:1) | `ring-2 ring-offset-2 ring-primary` |
| Active | scale reduction, shadow collapse | `scale(0.98)`, faster transition (50ms) |
| Disabled | opacity, cursor, pointer-events | `opacity: 0.4`, `cursor: not-allowed` |
| Loading | skeleton shimmer, spinner style | Gradient sweep at 1.5s |

**Hover State Tokens:**
- `state.hover.bgOpacity` — +8-12% darker/lighter (half-step on color scale)
- `state.hover.shadow.elevation` — +1 level (subtle lift)
- `state.hover.transform.translateY` — -1px to -2px
- `state.hover.transform.scale` — 1.02-1.05 (cards/images)
- `state.hover.transitionDelay` — 150-200ms (prevents accidental activation)

**Focus State Tokens (accessibility requirement):**
- `state.focus.ring.width` — 2px
- `state.focus.ring.offset` — 2px
- `state.focus.ring.color` — brand primary, must pass 3:1 contrast

**Active State Tokens:**
- `state.active.transform.scale` — 0.96-0.98 (physical press simulation)
- `state.active.transform.translateY` — 1px (push-down)
- `state.active.shadow` — reduced/inset
- `state.active.bg` — 2 steps darker on color scale
- `state.active.transitionDuration` — shorter than hover (50-100ms)

**Disabled State Tokens:**
- `state.disabled.opacity` — 0.4-0.5
- `state.disabled.cursor` — not-allowed
- `state.disabled.pointerEvents` — none
- `state.disabled.filter` — grayscale(100%) (optional)

**Loading States:**
- Skeleton shimmer: `linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)` at 1.5-2s
- Skeleton border-radius: match content shape (text = small, avatar = full)
- Spinner: 16-40px, 600-800ms rotation, 2-3px stroke, brand color
- Three patterns: shimmer (moving gradient), pulse (opacity oscillation), static (gray placeholders)

---

### Layer 5 — Motion & Easing (new)

**Duration Scale:**

| Token | Value | Use Case |
|-------|-------|----------|
| `duration.instant` | 0-100ms | Immediate feedback (color changes, opacity toggles) |
| `duration.fast` | 100-160ms | Micro-interactions (button press, checkbox toggle) |
| `duration.base` | 200-240ms | Standard UI transitions (hover states, dropdowns) |
| `duration.moderate` | 300-360ms | Larger transitions (modals, panels, accordions) |
| `duration.slow` | 500ms | Page-level transitions, scroll-triggered reveals |
| `duration.glacial` | 1000ms | Only for illustrative/decorative animations |

Key insight: Most UI animations should be 200-300ms. Never exceed 1s unless illustrative. Scale duration with the size of the change.

**Easing Curves:**

| Token | Value | Use Case |
|-------|-------|----------|
| `ease.default` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | General-purpose (CSS `ease`) |
| `ease.out` | `cubic-bezier(0, 0, 0.2, 1)` | Elements entering (dropdowns, modals) |
| `ease.in` | `cubic-bezier(0.4, 0, 1, 1)` | Elements exiting/dismissing |
| `ease.inOut` | `cubic-bezier(0.4, 0, 0.2, 1)` | On-screen movement (repositioning) |
| `ease.spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful micro-interactions |
| `ease.snappy` | `cubic-bezier(0.65, 0, 0.35, 1)` | Symmetric, premium feel |
| `ease.strongOut` | `cubic-bezier(0.16, 1, 0.3, 1)` | Fast-entering elements (scroll reveals) |

**The Easing Blueprint (from Vercel/animations.dev):**
- Element entering or exiting → `ease-out`
- On-screen element moving → `ease-in-out`
- Hover/color transitions → `ease`
- Seen 100+ times daily → don't animate it
- Avoid built-in CSS easings except `ease` and `linear`
- **Never use `transition: all`** — explicitly list properties to animate

**Easing as Brand Identity:**

| Brand Archetype | Easing Character | Example Curve | Used By |
|----------------|-----------------|---------------|---------|
| Precise & Minimal | Subtle ease-out | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Linear, Notion |
| Fast & Technical | Strong ease-out | `cubic-bezier(0.16, 1, 0.3, 1)` | Vercel, Raycast |
| Polished & Premium | Slight overshoot | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Stripe, Apple |
| Playful & Expressive | Spring/bounce | `cubic-bezier(0.68, -0.6, 0.32, 1.6)` | Mailchimp, Figma |
| Corporate & Serious | Standard ease-in-out | `cubic-bezier(0.42, 0, 0.58, 1)` | Enterprise SaaS |

**Per-Component Transition Properties:**

| Component | Properties | Duration | Easing |
|-----------|-----------|----------|--------|
| Button | background-color, color, box-shadow, transform | fast (150ms) | ease |
| Link | color, text-decoration-color | fast (150ms) | ease |
| Card | box-shadow, transform | base (200ms) | ease-out |
| Modal | opacity, transform | moderate (300ms) | ease-out |
| Tooltip | opacity | fast (150ms) | ease-out |

**Scroll-Triggered Animations:**
- Intersection Observer: `threshold: 0.15`, `rootMargin: "0px 0px -50px 0px"`
- Patterns: fade-in, slide-up (translateY 20-30px), slide left/right, scale-in
- Duration: 400-600ms with ease-out
- Stagger: 50-100ms per child increment, max 500ms cap
- CSS-only alternative: `animation-timeline: view()` (Chrome 115+, Firefox 133+)
- Performance: only animate `transform` and `opacity`

**Micro-interactions:**
- Button press: hover lift → active snap-down → release bounce → idle settle
- Link underline: scaleX pseudo-element (`::after` with `scaleX(0)` → `scaleX(1)`)
- Input focus: border color transition + subtle glow (`box-shadow: 0 0 0 3px rgba(brand, 0.1)`)

**Page Transitions:**
- View Transitions API (Oct 2025 Baseline): Chrome 111+, Firefox 133+, Safari 18+
- Duration: 200-300ms, easing: ease-in-out
- Graceful degradation: DOM updates work without animation
- Fallback: simple opacity crossfade 200ms ease-out

**Recommended token structure:**
```json
{
  "motion": {
    "duration": {
      "instant": "50ms",
      "fast": "150ms",
      "base": "200ms",
      "moderate": "300ms",
      "slow": "500ms"
    },
    "easing": {
      "default": "cubic-bezier(0.25, 0.1, 0.25, 1)",
      "out": "cubic-bezier(0, 0, 0.2, 1)",
      "in": "cubic-bezier(0.4, 0, 1, 1)",
      "inOut": "cubic-bezier(0.4, 0, 0.2, 1)",
      "spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      "brand": "[site-specific custom curve]"
    },
    "state": {
      "hover": { "bgShift": "8%", "elevationDelta": "+1", "translateY": "-1px" },
      "focus": { "ringWidth": "2px", "ringOffset": "2px" },
      "active": { "scale": "0.98", "translateY": "1px", "shadowReduction": "50%" },
      "disabled": { "opacity": "0.4" }
    },
    "scroll": {
      "reveal": { "offset": "20px", "duration": "300ms", "easing": "ease-out", "staggerDelay": "75ms" }
    },
    "skeleton": {
      "shimmerDuration": "1.5s",
      "shimmerGradient": "linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)"
    }
  }
}
```

---

### Layer 6 — Visual Identity (new)

| Token | What it captures |
|-------|-----------------|
| 60-30-10 color distribution | Which colors dominate vs accent |
| Color temperature strategy | Cool vs warm palette positioning |
| Saturation levels | Desaturated backgrounds, saturated CTAs |
| Contrast pairs | Specific foreground/background ratios |
| Border style language | Width patterns, divider conventions, focus rings |

**Visual Weight Distribution:**
- Value contrast — difference in lightness between elements and background
- Color temperature — cool (blue/green) vs warm (red/orange) vs neutral
- Saturation strategy — bright sparingly for attention, muted for backgrounds
- 60-30-10 rule — 60% dominant/neutral, 30% secondary, 10% accent
- WCAG contrast ratios — normal text: 4.5:1, large text: 3:1, UI components: 3:1

**Border Styles:**
- Border-width patterns — thin (1px) for subtle, thick for emphasis
- Border-color tokens — should be token-driven, not hardcoded gray
- Subtle dividers — `border-top: 1px solid {color.border.subtle}` between sections
- Dark mode adaptation — subtle separators vanish in dark mode; use `color-mix()` or per-theme tokens
- Focus borders — must meet WCAG 3:1 contrast

**Recommended token structure:**
```json
{
  "visualIdentity": {
    "colorDistribution": {
      "dominant": { "color": "{color.neutral.50}", "usage": "60%", "role": "backgrounds" },
      "secondary": { "color": "{color.brand.100}", "usage": "30%", "role": "surfaces" },
      "accent": { "color": "{color.brand.500}", "usage": "10%", "role": "CTAs" }
    },
    "contrastPairs": {
      "textOnSurface": { "foreground": "{color.neutral.900}", "background": "{color.neutral.50}", "ratio": "15.4:1" },
      "textOnPrimary": { "foreground": "{color.white}", "background": "{color.brand.600}", "ratio": "5.2:1" }
    },
    "borders": {
      "default": { "width": "1px", "style": "solid", "color": "{color.border.default}" },
      "subtle": { "width": "1px", "style": "solid", "color": "{color.border.subtle}" },
      "emphasis": { "width": "2px", "style": "solid", "color": "{color.border.emphasis}" },
      "divider": { "width": "1px", "style": "solid", "color": "{color.border.muted}" }
    }
  }
}
```

---

## Proposed Multi-Pass Extraction Pipeline

```
Pass 1 — Atomic tokens        (Playwright getComputedStyle)     → design-tokens.json
Pass 2 — Layout & rhythm       (DOM inspection, responsive testing) → layout-tokens.json
Pass 3 — Component recipes     (per-component style extraction)  → component-recipes.json
Pass 4 — Interaction & motion  (hover/focus/active observation) → motion-tokens.json
Pass 5 — Visual identity       (color distribution analysis)     → identity-tokens.json
```

---

## Design System References

| System | Key Contributions |
|--------|------------------|
| **Apple HIG** | Materials (ultra-thin to ultra-thick), vibrancy, Liquid Glass (iOS 26) |
| **Vercel/Geist** | High-contrast color system, gradients as core aesthetic, animations.dev |
| **Linear** | Grainy gradients (SVG noise + color), glassmorphism, dark-first |
| **Stripe** | WebGL mesh gradient (MiniGL), morphing navigation, hand-crafted animations |
| **Material Design 3** | 3-tier token architecture, 141 system + 800+ component tokens |
| **Primer (GitHub)** | Pragmatic component tokens, color scales 0-13 |
| **Polaris (Shopify)** | Semantic tokens with `--p-` prefix, component spacing tokens |
| **Cloudscape (AWS)** | Explicit density modes (comfortable/compact) |

## W3C DTCG Specification (2025.10)

- First stable version of Design Tokens Community Group spec
- JSON format with `$type`, `$value`, `$description`, `$extensions`
- 13 token types including composite: shadow, gradient, typography, border
- File extension: `.tokens` or `.tokens.json`
- Backed by Adobe, Amazon, Google, Microsoft, Meta, Figma, Shopify

## Category Priorities

### Essential (must-have to feel right)
- Duration scale & core easing curves
- Per-component transition properties (explicit, never `all`)
- Hover/focus/active/disabled states
- Skeleton loading states
- `prefers-reduced-motion` support
- Button press micro-interaction
- Component style recipes (shape + surface + state properties)

### Important (significantly improves feel)
- Gradients (linear/radial with color stops)
- Glass/blur effects for depth
- Scroll-triggered fade-in/slide-up
- Staggered children animations
- Link underline animation
- Section rhythm patterns
- Density mode
- Brand-specific easing curve (motion personality)
- Page transitions (View Transitions API)

### Nice-to-have (polish layer)
- Texture/noise (SVG feTurbulence)
- Mesh gradients (WebGL)
- Spring physics (Framer Motion)
- Scroll-driven CSS animations
- Morphing navigation
- GSAP ScrollTrigger (pinning, snapping)
- Smooth scroll library (Lenis)
- Checkbox/radio bounce animations
