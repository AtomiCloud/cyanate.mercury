---
name: iterate-and-fix
description: Iteratively fix specific failing files based on validation errors or quality feedback. Perform targeted re-generation of individual files with error context injected. Use this skill when validation fails, quality scores are too low, or specific files need re-generation. Always use this skill after validate-and-repair or test-and-quality when errors persist, or when the user mentions "fix this file", "re-generate", "iterate", or needs to address specific feedback.
---

# Iterate and Fix

Perform targeted re-generation of specific failing files with error context or quality feedback.

## When to use this skill

Use this skill when:
- Validation found errors that couldn't be auto-fixed
- Quality score < 7 requires re-generation
- Specific files need targeted fixes
- User provides feedback on generated code

## Your task

1. **Read the failing file** to understand current state
2. **Read error/quality context** to understand what's wrong
3. **Re-generate ONLY the failing file** with context
4. **Re-run validation** on the fixed file
5. **Maximum 2 retries** per file before flagging for human review

## Input context

You'll receive one or both of:

### Validation context
```json
{
  "file": "src/pages/index.astro",
  "violations": [
    {
      "rule": "missing-hero-section",
      "message": "Hero section not present"
    }
  ]
}
```

### Quality context
```json
{
  "page": "index",
  "scores": {
    "layoutConsistency": 4,
    "feedback": "Hero section missing features grid"
  },
  "overallScore": 5.2
}
```

## Generation prompt pattern

When re-generating a file, include:

1. **Current code** - Show what exists
2. **Error/feedback** - What's wrong
3. **Design brief for this file** - What it should be
4. **Specific fix needed** - What to change

Example prompt:
```
Re-generate src/pages/index.astro.

CURRENT CODE:
[paste current file content]

ERRORS:
- Hero section not present
- Features grid has wrong number of columns

DESIGN BRIEF FOR THIS PAGE:
- Sections: hero (heading, subheading, cta), features (3 items grid)

FIX NEEDED:
Add hero section at top, fix features grid to have 3 columns.

Generate the corrected file.
```

## Retry rules

- **Max 2 retries** per file
- After 2nd failure, flag for human review
- If different files fail, retry each independently
- Don't re-generate files that passed

## Files to re-generate

**ONLY re-generate failing files.** Don't touch:
- Files that passed validation
- Files with good quality scores
- Template files (src/layouts/* if they work)
- Dependencies and config files

## Important notes

- **Read common-failures.md** for known failure patterns
- Use Edit tool for surgical fixes (small changes)
- Use Write tool for full re-generation (major issues)
- Include the specific error details in the re-generation prompt
- Re-run validation after each fix

## Output format

After fixing, report:

```json
{
  "file": "src/pages/index.astro",
  "retries": 1,
  "fixed": true,
  "validationAfter": "passed"
}
```

## Flag for human review

Flag when:
- 2 retries failed
- Error unclear or ambiguous
- Design brief itself is problematic
- Quality issues persist despite fixes

## Loop back to validation

After fixes, always:
1. Re-run validate-and-repair on fixed files
2. Re-run test-and-quality if visual issues
3. Only proceed when all critical issues resolved
