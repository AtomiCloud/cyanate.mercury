---
name: validate-and-repair
description: Validate generated Astro.js code and apply auto-fixes for common errors. Run static checks (astro check, tsc, build) and repair known error patterns. Use this skill when you need to validate generated code, fix build errors, or repair common Astro/Shadcn integration issues. Always use this skill after code generation, when tests fail, or when the user mentions "validation", "fix errors", "repair code", or "build failed".
---

# Validate and Repair

Validate generated Astro.js code and apply auto-fixes for common errors. Outputs validation reports and applies surgical fixes.

## When to use this skill

Use this skill when you need to:
- Run static validation on generated Astro code
- Fix build errors
- Apply auto-fixes for known error patterns
- Verify code quality before deployment

## Your task

1. **Run validation checks** on the Astro project
2. **Generate validation report** as `validation-report.json`
3. **Apply auto-fixes** for repairable errors
4. **Re-run validation** to verify fixes

## Validation checks

Run these commands in order:

```bash
# 1. Astro syntax check
bunx astro check

# 2. TypeScript check
bun run typecheck

# 3. Build test
bun run build
```

## Output format

Save as `validation-report.json`:

```json
{
  "files": [
    {
      "file": "src/pages/index.astro",
      "passed": true,
      "violations": []
    },
    {
      "file": "src/components/Header.astro",
      "passed": false,
      "violations": [
        {
          "rule": "missing-layout-import",
          "severity": "error",
          "line": 1,
          "message": "Page must import Layout",
          "autoFixable": true
        }
      ]
    }
  ]
}
```

## Auto-fixable violations

See `references/common-errors.md` for the full list of auto-fixable patterns.

## Validation rules to check

### For ALL `.astro` files:
- File parses as valid Astro (frontmatter fences present)
- No `{tokens.`, `${theme.`, `{colors.` patterns (unreplaced tokens)
- No inline `style="..."` with raw colors
- No `bg-[#...]`, `text-[#...]` arbitrary Tailwind colors
- No `<html>`, `<head>`, `<body>` in component files (only in Layout)
- All imports use `@/` path alias for ui/lib

### For page files (`src/pages/*.astro`):
- Imports Layout component
- Wraps content in `<Layout>...</Layout>`
- Has valid frontmatter

### For Shadcn component usage:
- Imports from `@/components/ui/[name]`
- Interactive components have `client:load` or `client:visible`
- `cn()` imported from `@/lib/utils` when used

### For `globals.css`:
- Required imports present
- `@theme inline` block with color mappings
- CSS variables defined in `:root`
- Values in OKLCH format

## Build check

- `astro build` completes without errors
- No TypeScript errors
- All assets generated correctly

## Important notes

- **Read common-errors.md** before applying fixes
- Apply fixes **surgically** - only change what's broken
- Re-run validation after each fix
- Report which files were modified
- Use Edit tool for precise changes

## Exit codes

- If all checks pass: Output "✅ VALIDATION_PASSED"
- If errors found: Output validation report and apply auto-fixes
- If auto-fixes fail: Flag for manual review