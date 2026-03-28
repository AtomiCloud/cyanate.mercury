# Design Style Classification Research

## Problem

When scraping a website for code generation, knowing its **design style** is critical. A "minimalist" site and a "neobrutalist" site may share the same color palette, but the code generation approach should be completely different. We need a **style fingerprint** — a structured classification that can be extracted programmatically and consumed by the codegen pipeline.

---

## Recommended Approach: Hybrid Classification Schema

Combines three layers:
1. **Categorical labels** — Primary style (e.g., "minimalist") + secondary influences (e.g., "glassmorphism")
2. **Dimensional axes** — 8 continuous scales (0.0-1.0) that capture nuance and blending
3. **Actionable treatments** — Direct CSS/pattern guidance for code generation

### Why hybrid?
- **Categories** = fast heuristic recognition (human-readable, quick matching)
- **Dimensions** = capture nuance (two "minimalist" sites can differ vastly in warmth, density, motion)
- **Treatments** = directly actionable for code generation (map to CSS properties)

---

## Schema Format

```json
{
  "$schema": "style-fingerprint/v1",

  "style": {
    "primary": "minimalist",
    "secondary": ["glassmorphism"],

    "dimensions": {
      "ornament":    0.15,
      "playfulness": 0.30,
      "warmth":      0.55,
      "density":     0.25,
      "motion":      0.40,
      "depth":       0.60,
      "darkness":    0.20,
      "formality":   0.70
    },

    "treatments": {
      "surface": "frosted-glass",
      "corners": "rounded-large",
      "shadows": "layered-soft",
      "borders": "subtle",
      "gradients": "background-subtle",
      "blur": true,
      "transparency": true,
      "animation_style": "spring-gentle"
    },

    "confidence": 0.85
  }
}
```

---

## Dimension Definitions (0.0 to 1.0)

| Dimension | 0.0 (Low) | 1.0 (High) | Extraction Method |
|-----------|-----------|------------|-------------------|
| **ornament** | Minimal, stripped-down | Ornate, decorative | Border complexity, decorative element count, texture usage |
| **playfulness** | Serious, professional | Whimsical, energetic | Color saturation, shape irregularity, illustration presence |
| **warmth** | Cool, clinical, blue-gray | Warm, inviting, earthy | Color temperature analysis, serif ratio |
| **density** | Airy, spacious | Dense, information-rich | Content-to-whitespace ratio, element count per viewport |
| **motion** | Static, no animation | Highly animated | CSS animation count, transition properties |
| **depth** | Flat, single-plane | Layered, shadows, parallax | Shadow count/spread, z-index range, transform3d |
| **darkness** | Light-first | Dark-first | Background luminance, dark-mode-default detection |
| **formality** | Casual, rule-breaking | Structured, grid-conforming | Grid regularity, font formality, color restraint |

---

## Treatment Values

### Surface
| Value | Description | Maps to |
|-------|-------------|---------|
| `flat-solid` | No depth, solid colors | `background: solid` |
| `flat-gradient` | Simple gradient backgrounds | `linear-gradient()` |
| `frosted-glass` | Translucent blur panels | `backdrop-filter: blur()` |
| `textured` | Noise/pattern overlays | SVG `feTurbulence`, background-image |
| `mesh-gradient` | Complex multi-color mesh | WebGL (MiniGL) or CSS mesh |

### Corners
| Value | Range | Style association |
|-------|-------|-------------------|
| `sharp` | 0px | Brutalist, Swiss |
| `small` | 2-6px | Corporate, traditional |
| `medium` | 8-12px | Modern SaaS, Material |
| `large` | 12-24px | Bento grid, playful |
| `pill` | 9999px | Friendly, pill buttons |
| `squircle` | continuous corner | Apple-style |

### Shadows
| Value | Description | CSS pattern |
|-------|-------------|-------------|
| `none` | No shadows | Flat design, brutalist |
| `hard-offset` | Thick, solid offset | `4px 4px 0 #000` (neobrutalist) |
| `soft-single` | One soft shadow | `0 4px 6px rgba(0,0,0,0.1)` |
| `layered-soft` | Multiple soft shadows | Material elevation, modern cards |
| `dual-light-dark` | Neumorphic pair | Light highlight + dark shadow |
| `glow` | Colored, spread shadow | Dark-mode CTAs, neon effects |

### Borders
| Value | Description | Style association |
|-------|-------------|-------------------|
| `none` | No borders | Card-based, flat |
| `subtle` | 1px, low contrast | Modern, minimal |
| `standard` | 1px, token color | Corporate, SaaS |
| `thick` | 2-3px, solid | Neobrutalist, retro |
| `accent` | Colored borders | Playful, emphasis |

### Gradients
| Value | Description | Style association |
|-------|-------------|-------------------|
| `none` | Solid colors only | Flat, minimalist |
| `background-subtle` | Soft background gradients | Modern SaaS, editorial |
| `background-vibrant` | Bold, multi-color | Y2K, maximalist, creative |
| `text-gradient` | Gradient on text | Hero headlines, modern marketing |
| `mesh` | Complex mesh gradients | Stripe, Vercel |

### Animation Style
| Value | Description | Easing pattern |
|-------|-------------|----------------|
| `none` | No animations | Brutalist, static |
| `subtle` | Quick color/opacity fades | 150-200ms ease |
| `spring-gentle` | Slight overshoot, soft | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| `spring-bouncy` | Noticeable bounce | `cubic-bezier(0.68, -0.6, 0.32, 1.6)` |
| `snappy` | Quick, responsive | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `cinematic` | Slow, dramatic | >400ms ease-in-out |
| `playful` | Varied, attention-grabbing | Custom bezier, staggered |

---

## Measurable Attributes → Style Classification

### Whitespace / Density
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Content-to-whitespace ratio | `getBoundingClientRect()` area sum vs viewport | >60% = luxury/editorial, 40-60% = modern, <25% = dense/brutalist |
| Element density per viewport | Visible element count / viewport area | Low = airy, high = dashboard/data |
| Spacing grid consistency | Modulo of all padding/margin vs base unit | >90% = design-system, <50% = organic/brutalist |

### Color
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Unique color count | All colors deduplicated in LAB (deltaE < 3) | <5 + low sat = minimalist, >15 = playful/eclectic |
| Saturation distribution | Mean/median HSL saturation | High sat = bold/neobrutalist, low sat = muted/luxury |
| Color temperature | Warm vs cool hue ratio | Warm = friendly, cool = professional |
| Contrast ratio range | WCAG formula on all text/bg pairs | >7:1 avg = brutalist, <3:1 = neumorphic/luxury |
| Palette size | Clustered in LAB (deltaE > 10) | 2-3 = brand-focused, 5-10 = corporate, >10 = eclectic |

### Typography
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Font family count | Unique `fontFamily` values | 1 sans = modern, serif+sans = editorial, 3+ = eclectic |
| Serif vs sans ratio | Classify by generic family | High serif = editorial/luxury, all sans = modern |
| Size contrast ratio | max(fontSize) / min(fontSize) | >5:1 = bold/editorial, <2:1 = flat/dashboard |
| Uppercase usage | Elements with `text-transform: uppercase` | >30% = brutalist/corporate/luxury |
| Letter-spacing distribution | Average `letterSpacing` | Wide (>0.1em) = luxury/editorial, tight (<-0.01em) = tech |
| Monospace presence | Any `font-family: monospace` | Dev-focused, brutalist, retro |

### Shape / Form
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Border-radius average | Mean of all `borderRadius` values | >16px = soft/playful, 0px = brutalist |
| Border-width patterns | Mean and frequency | >2px solid = neobrutalist, 0-1px = modern |
| Shadow type | Parse `boxShadow` components | Blur>20px = material, blur=0 hard offset = neobrutalist |
| Dual shadows | Count comma-separated shadows | 2 = neumorphic, 1 = standard |

### Layout
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Grid strictness | % of elements snapped to grid lines | >90% = Swiss/corporate, <60% = organic/editorial |
| Content width ratio | Main container / viewport | <0.5 = editorial/luxury, >0.9 = dashboard/brutalist |
| Column consistency | Cluster count of alignment tracks | High = corporate/SaaS, low = editorial/creative |
| Display distribution | flex vs grid vs block ratio | High flex = modern component, high grid = design-system |

### Motion
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Transition duration range | All `transitionDuration` values | 100-200ms = snappy, >500ms = cinematic |
| Easing curve types | Classify `transitionTimingFunction` | Custom bezier with overshoot = playful |
| Animation density | Elements with `animationName != none` / total | >20% = highly animated, <5% = restrained |

### Texture / Depth
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Gradient usage | `backgroundImage` containing gradient keywords | None = flat, 2-stop = modern, multi-stop = vibrant |
| Backdrop-filter presence | `backdropFilter: blur()` count | Present = glassmorphic |
| Opacity variation | Elements with `opacity < 1` | High = glassmorphic/layered |
| Z-index depth range | max zIndex - min zIndex | >100 = complex, <10 = flat/organized |

### Images
| Metric | Extraction | Style mapping |
|--------|-----------|---------------|
| Image-to-text ratio | Media area vs text block area | >60% = visual-first, <20% = text-heavy |
| SVG vs raster ratio | `<svg>` count vs `<img>` count | High SVG = modern tech, high raster = photography-driven |
| Hero image presence | Large image in first viewport | Present = editorial/lifestyle, absent = text-first |

### Composite Classification Matrix

| Style | Whitespace | Colors | Typography | Shapes | Layout | Motion | Texture | Images |
|-------|-----------|--------|------------|--------|--------|--------|---------|--------|
| **Minimalist** | >55% | <5, low sat | 1 sans, wide spacing | radius 8-16px, no shadow | Strict grid | Subtle, 200ms | None | Low |
| **Brutalist** | Variable | <5, high contrast | Mono/bold, high size ratio | radius 0, hard shadow | Broken grid | None | None | Text-heavy |
| **Neobrutalist** | 30-50% | Bold, high sat, <8 | 1-2 bold, large headers | radius 0-8, hard offset, thick borders | Semi-structured | Minimal | None | Mixed |
| **Corporate** | 35-50% | 5-10, brand-aligned | 2 fonts, moderate | radius 4-8px, subtle shadow | Strict columns | Standard 200-300ms | Subtle gradients | Balanced |
| **Luxury/Editorial** | >50% | <6, low sat or rich | Serif + sans, wide spacing | radius 0-4px | Asymmetric, narrow | Slow >400ms | Minimal | Photo-heavy |
| **Playful** | 30-45% | >8, high sat, warm | Display fonts, varied | radius >16px (pills) | Organic, dynamic | Bouncy, custom bezier | Gradients, textures | Illustrations |
| **Glassmorphic** | 40-55% | Moderate, translucent | Clean sans-serif | Large radius, blur shadows | Layered | Smooth, medium | Backdrop-filter, gradients | Background-focused |
| **Neumorphic** | 45-55% | Monochrome, low sat | Clean, minimal | Large radius, dual shadows | Minimal | Subtle | Flat + soft depth | Minimal |
| **Material/Modern** | 35-50% | Brand palette, 5-10 | System font, clear hierarchy | radius 4-12px, layered shadows | Grid + flex | 200-300ms ease | Subtle elevation | Balanced |
| **Dashboard** | <30% | 8-15, functional | Small sizes, low contrast | radius 4-8px, card shadows | Dense grid, sidebar | Snappy <200ms | Minimal | Charts/icons |

---

## Style Category Reference

### The 20 Web Design Styles

#### 1. MINIMALIST
**Characteristics:** Maximum whitespace, few elements, no decoration, monochrome or one accent. Every element justifies its existence.
**Examples:** Apple.com, Muji, Everlane
**Not:** Brutalist, editorial, maximalist
**Signature:** Restraint. Size hierarchy through whitespace alone.

#### 2. FLAT DESIGN
**Characteristics:** 2D elements, no gradients/shadows (in pure form), solid colors, simple icons. Rooted in Swiss Design.
**Examples:** Early Windows 8 Metro, iOS 7+
**Not:** Skeuomorphic, neumorphic. Flat 2.0 adds subtle depth.
**Signature:** Complete absence of depth simulation.

#### 3. MATERIAL DESIGN
**Characteristics:** Google's system. Structured z-axis shadows, elevation levels, 8dp grid, responsive animations.
**Examples:** Gmail, Google Maps, Android apps
**Not:** Flat (has shadows), glassmorphic (opaque), neumorphic (hard shadows)
**Signature:** Codified elevation system with precise specs.

#### 4. NEUMORPHISM
**Characteristics:** Soft extruded UI, dual shadows (light+dark), monochromatic surfaces. Rose fast (2019-2021) due to accessibility issues.
**Examples:** Concept UIs on Dribbble, wellness apps
**Not:** Glassmorphic (opaque), flat (has depth), skeuomorphic (no real textures)
**Signature:** Dual-shadow on monochromatic background.

#### 5. GLASSMORPHISM
**Characteristics:** Frosted glass via `backdrop-filter: blur()`, translucent backgrounds, vivid gradients behind glass, subtle borders.
**Examples:** macOS Big Sur, Windows 11, Webflow templates
**Not:** Neumorphic (transparent vs opaque), flat (heavy depth), minimalist (visually rich)
**Signature:** The `backdrop-filter: blur()` effect is the technical signature.

#### 6. BRUTALISM (WEB)
**Characteristics:** Raw, unfinished, utilitarian. Anti-design. Plain HTML aesthetic, deliberately crude.
**Examples:** Drudge Report, Craigslist
**Not:** Neobrutalist (which is polished), minimalist (can be chaotic)
**Signature:** Rejection of design polish. Looks intentionally un-designed.

#### 7. NEOBRUTALISM
**Characteristics:** High contrast, bold colors, thick black borders, hard drop shadows, blocky layouts. Polished evolution of brutalism.
**Examples:** Figma marketing, Gumroad, Notion marketing
**Not:** Brutalist (intentionally designed), flat (strong shadows), minimalist
**Signature:** Thick black border + hard offset shadow combination.

#### 8. SWISS / INTERNATIONAL
**Characteristics:** Grid-based, asymmetric composition, typography as primary element. "Design is communication, not self-expression."
**Examples:** Apple product pages, museum websites
**Not:** Decorative, editorial (more restrained), brutalist (highly ordered)
**Signature:** Mathematical precision and neutrality. Typography IS the design.

#### 9. EDITORIAL / MAGAZINE
**Characteristics:** Print magazine DNA. Complex compositions, large photography, dramatic headlines, pull quotes, multi-column.
**Examples:** Bloomberg, Kinfolk, Cereal Magazine
**Not:** Minimalist (content-dense), flat (rich layering), SaaS-style
**Signature:** Layouts that feel at home in Vogue or Monocle.

#### 10. BENTO GRID
**Characteristics:** Modular asymmetric cards of varying sizes. Consistent gaps are critical. 67% of top SaaS sites use some form.
**Examples:** Apple product pages, Notion, Linear, Supabase
**Not:** Equal-width grid (asymmetric sizes are key), masonry (structured not waterfall), dashboard (marketing not functional)
**Signature:** Asymmetric-but-balanced card sizing with uniform gaps.

#### 11. DARK MODE-FIRST
**Characteristics:** Dark grey (#0a-#1a) not pure black. Surface elevation hierarchy via shade variations. Neon/saturated accents that glow.
**Examples:** Linear, Vercel, Raycast, GitHub dark mode
**Not:** Just inverted colors — intentional design for hierarchy and eye comfort.
**Signature:** Surface elevation via dark shade variations + glowing accents.

#### 12. CORPORATE / ENTERPRISE
**Characteristics:** Professional, safe, blue-dominant (trust signaling). Clean layouts prioritizing clarity. Design serves business communication.
**Examples:** Salesforce, IBM, Cisco, Oracle
**Not:** Editorial (not dramatic), brutalist (not confrontational)
**Signature:** "Safe" over "distinctive." Trustworthy but rarely memorable.

#### 13. Y2K / RETRO-FUTURISTIC
**Characteristics:** 1998-2003 nostalgia. Chrome textures, 3D effects, pixel art, bubble shapes, iridescent gradients, glitch elements.
**Examples:** Charli XCX "Brat" era, Balenciaga campaigns
**Not:** Vaporwave (energetic not melancholic), cyberpunk (playful not dystopian)
**Signature:** Optimistic futurism of late 90s tech, filtered through nostalgia.

#### 14. HAND-DRAWN / ILLUSTRATIVE
**Characteristics:** Custom illustrations, hand-lettering, deliberately imperfect. Human feel contrasting digital precision.
**Examples:** Dropbox 2017-era, Mailchimp illustration era
**Not:** Polished/corporate (intentionally rough), minimalist (visually active)
**Signature:** Human imperfection as aesthetic. No machine-generated elements.

#### 15. CONSTRUCTIVIST / AVANT-GARDE
**Characteristics:** Geometry-driven, asymmetric, bold diagonals, photomontage. Russian Constructivism (1920s) roots.
**Examples:** Fashion brands, art exhibition sites
**Not:** Swiss (ordered vs dynamic), corporate (too confrontational)
**Signature:** Diagonal energy and political/revolutionary undertones.

#### 16. ORGANIC / NATURE-INSPIRED
**Characteristics:** Flowing curves, biomorphic shapes, earthy textures, nature photography. Anti-geometric.
**Examples:** Wellness brands, Aesop, eco companies
**Not:** Geometric (no sharp angles), technical/dark-mode (warm not cool)
**Signature:** Curves everywhere — no straight lines if possible.

#### 17. GLASSMORPHISM + GRADIENT (Modern SaaS)
**Characteristics:** The dominant 2024-2026 SaaS style. Combines gradients, frosted glass, subtle animations, bento grids. The "default good SaaS design."
**Examples:** Vercel, Linear, Raycast, Resend, Clerk
**Not:** Corporate (too rich), minimalist (gradient-heavy), retro
**Signature:** Glass + gradients + dark mode + bento = current SaaS default.

#### 18. MAXIMALIST / DOPAMINE DESIGN
**Characteristics:** More is more. Dense, bold colors, clashing patterns, visual noise. Rejection of minimalism.
**Examples:** Balenciaga, Supreme, Gen-Z brands
**Not:** Minimalist (opposite), corporate (too chaotic)
**Signature:** Intentional sensory overload.

#### 19. RETRO / VINTAGE
**Characteristics:** Nostalgic references to specific past eras (50s-80s). Tactile UI elements, vintage textures, period typography.
**Examples:** Craft breweries, vintage shops, barber shops
**Not:** Y2K (broader era range), modern minimalist (embraces decoration)
**Signature:** Period-accurate visual language from a specific decade.

#### 20. LUXURY / HIGH-FASHION
**Characteristics:** Extreme negative space, high-end photography, restrained palette, elegant serifs, slow animations. "Less but better" at its extreme.
**Examples:** Chanel, Rolex, Aesop
**Not:** Minimalist (deliberately opulent in restraint), corporate (not informational)
**Signature:** Every pixel communicates exclusivity and quality.

---

## Industry-Specific Style Tendencies

| Industry | Dominant Style(s) | Key Patterns |
|----------|-------------------|--------------|
| SaaS Landing Pages | Modern SaaS (gradient+glass+bento), Dark-mode-first | Hero + social proof + feature grid + pricing |
| E-Commerce | Minimalist (luxury) or Grid-heavy (mass market) | Product cards, filtering, cart |
| Portfolio | Editorial, Minimalist, Maximalist | Project showcases, case studies |
| Documentation | Swiss/Flat, Minimal | Left sidebar nav, clean typography, code blocks |
| Dashboard | Material/Flat | Data viz, card widgets, sidebar nav |
| Editorial/Magazine | Editorial style | Multi-column, large imagery, pull quotes |

---

## How AI Tools Classify Styles (Current State)

| Tool | Method | Gap |
|------|--------|-----|
| **Framer AI** | Free-text prompt → AI infers style | No formal taxonomy |
| **Wix ADI** | Questionnaire → business type → style preference | Industry-based, not visual |
| **Dora AI** | Visual storytelling presets | Motion-focused only |
| **Typedream** | Template categories by industry | Format-based, not style-based |
| **Midjourney** | Compositional prompts: `[style] + [treatment] + [mood] + [layout]` | Natural language, not structured |
| **Material 3** | Expressive vs Standard schemes | Only 2 modes |
| **Radix Themes** | Configurable axes (color, radius, scaling, appearance) | Closest to structured "style knobs" |

**Key finding:** No AI builder uses a formal style taxonomy. This is a gap our schema fills.

---

## Classification Algorithm Approach

1. **Extract all measurable attributes** via Playwright (whitespace, colors, typography, shapes, layout, motion, texture, images)
2. **Compute dimension scores** (0.0-1.0) from attribute values
3. **Match to style archetypes** using cosine similarity against the composite classification matrix
4. **Assign primary + secondary labels** based on top matches
5. **Map to treatments** using dimension thresholds
6. **Output style fingerprint JSON** for codegen consumption

---

## References

- [Siteinspire](https://www.siteinspire.com/) — Web design gallery with style filters
- [Mobbin](https://mobbin.com/) — 300,000+ real shipped product UI screenshots
- [Lapa Ninja](https://www.lapa.ninja/) — Landing page examples by category
- [Material Design 3](https://m3.material.io/) — Expressive vs Standard, 141 system + 800+ component tokens
- [Radix Themes](https://www.radix-ui.com/themes) — Configurable style axes
- [W3C DTCG Spec (2025.10)](https://www.designtokens.org/) — Extensible token format for metadata
- [Brand Personality Sliders](https://www.nineblaess.de/blog/brand-personality-slider/) — Dimensional brand classification
- [animations.dev](https://www.animations.dev/) — Vercel's motion design guide
- [A List Apart: Personality in Design](https://alistapart.com/article/personality-in-design/) — Design persona framework
