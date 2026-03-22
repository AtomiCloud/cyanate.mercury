---
name: test-and-quality
description: Run functional and visual quality tests on generated Astro.js websites. Start dev server, visit pages, check for errors, and evaluate visual quality using automated heuristic checks. Use Webapp Testing Skill for Playwright automation. Always use this skill after code generation, when user mentions "testing", "quality check", "visual review", or needs to verify the generated site works correctly.
---

# Test and Quality

Run functional and visual quality tests on generated Astro.js websites using **automated heuristics** (no screenshots needed). Outputs test reports and quality scores.

## When to use this skill

Use this skill when you need to:
- Test generated website functionality
- Check for console errors and broken links
- Evaluate visual quality via heuristics
- Verify responsive design patterns
- Assess semantic HTML and accessibility

## Your task

1. **Start dev server** in headless mode
2. **Visit each page** and check for errors
3. **Run heuristic quality checks** on code
4. **Generate reports** as `test-report.json` and `quality-scores.json`

## Functional testing

### Start dev server

```bash
npm run dev --port 4322
```

Wait for server to start, then run tests.

### Test cases

For each page:
- ✅ Page loads without HTTP errors (200 status)
- ✅ No console errors on page
- ✅ Navigation links work (correct hrefs)
- ✅ Interactive components respond (dialogs open, dropdowns expand)
- ✅ Page renders content (not blank)

### Output format

Save as `test-report.json`:

```json
{
  "pages": [
    {
      "page": "index",
      "url": "/",
      "httpStatus": 200,
      "consoleErrors": [],
      "brokenLinks": [],
      "interactiveComponentsWorking": true,
      "hasContent": true,
      "passed": true
    }
  ]
}
```

## Visual quality testing (Heuristic-based)

Instead of screenshots, use **automated code checks** to evaluate quality.

### Heuristic checks

Run these checks programmatically:

| Check | How to verify | Score impact |
|-------|----------------|--------------|
| **Design tokens defined** | Check `globals.css` has CSS variables | 0-3 points |
| **Semantic HTML** | Check for `<header>`, `<nav>`, `<main>`, `<footer>` tags | 0-2 points |
| **Alt tags** | Check images have `alt` attributes | 0-1 points |
| **Responsive meta** | Check for viewport meta tag | 0-1 point |
| **Component usage** | Check Shadcn components imported | 0-2 points |
| **No broken links** | All hrefs resolve | 0-1 point |

### Quality evaluation dimensions

Score each 1-10 based on heuristic check results:

| Dimension | Max Score | Heuristic checks |
|-----------|-----------|------------------|
| `layoutConsistency` | 10 | Section structure matches design brief |
| `designTokenUsage` | 10 | CSS variables defined and used |
| `componentComposition` | 10 | Shadcn components properly imported |
| `responsiveDesign` | 10 | Viewport meta tag, responsive classes |
| `semanticHTML` | 10 | Semantic tags present |
| `accessibility` | 10 | Alt tags, ARIA labels, heading hierarchy |

### Output format

Save as `quality-scores.json`:

```json
{
  "pages": [
    {
      "page": "index",
      "scores": {
        "layoutConsistency": 8,
        "designTokenUsage": 9,
        "componentComposition": 7,
        "responsiveDesign": 8,
        "semanticHTML": 9,
        "accessibility": 8,
        "overallScore": 8.2
      },
      "heuristicChecks": {
        "designTokensDefined": true,
        "semanticHtmlUsed": true,
        "altTagsPresent": true,
        "viewportMeta": true,
        "shadcnComponentsImported": true,
        "noBrokenLinks": true
      },
      "feedback": "All heuristic checks passed. Page follows best practices."
    }
  ],
  "overallScore": 8.2,
  "threshold": 7.0,
  "passed": true
}
```

## Important notes

- Uses **Webapp Testing Skill** for Playwright automation
- Run server in headless mode (for Docker/Kubernetes)
- If `overallScore < 7`, trigger iterate-and-fix skill

## Quality threshold

- **Pass**: overallScore ≥ 7
- **Fail**: overallScore < 7 → trigger targeted re-generation

## Webapp Testing Skill integration

Use Playwright to:
- Start server with `with_server.py` helper
- Visit pages and capture console
- Click navigation links
- Test interactive components