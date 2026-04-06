# Common Failure Patterns and Fix Strategies

Known failure patterns in generated code and strategies for fixing them.

## Failure categories

### 1. Missing sections

**Pattern:** Section from design brief not present in generated file

**Example:**
```json
// Design brief has:
"sections": ["hero", "features", "testimonials"]

// Generated file only has:
hero and features (missing testimonials)
```

**Fix strategy:**
1. Read current file
2. Identify which sections are missing
3. Re-generate with prompt: "Add the missing testimonials section with [specifications from brief]"
4. Insert missing section in correct position

---

### 2. Wrong component usage

**Pattern:** Wrong Shadcn component used, or component not used at all

**Example:**
```json
// Design brief specifies:
"components": ["Card", "Badge"]

// Generated file uses:
Only Card, no Badge
```

**Fix strategy:**
1. Identify which component is wrong/missing
2. Look at design brief for correct component
3. Read Shadcn component docs via Shadcn Skill
4. Replace or add the correct component

---

### 3. Layout not matching brief

**Pattern:** Tailwind classes don't match layout specification

**Example:**
```json
// Design brief specifies:
"layout": "grid grid-cols-3 gap-6"

// Generated file has:
"grid grid-cols-2 gap-4"
```

**Fix strategy:**
1. Extract layout from design brief
2. Find the section with wrong layout in generated file
3. Update Tailwind classes to match brief exactly
4. Use Edit tool for surgical change

---

### 4. Content not mapping correctly

**Pattern:** Content fields from content.json not appearing in output

**Example:**
```json
// content.json has: { "heading": "Welcome", "subheading": "Get Started" }

// Generated file has: Static "Hello World" text
```

**Fix strategy:**
1. Read content.json to understand available fields
2. Check design brief for field mappings ({{heading}}, {{subheading}})
3. Update file to use correct field references
4. Ensure content is properly injected

---

### 5. Responsive issues

**Pattern:** Layout breaks on mobile or tablet

**Example:**
```
Design brief: "3-column grid on desktop, 1-column on mobile"
Generated: Always 3 columns (breaks on mobile)
```

**Fix strategy:**
1. Add responsive breakpoint classes
2. Use `grid-cols-1 md:grid-cols-3` pattern
3. Test at multiple viewports
4. Adjust spacing for mobile

---

### 6. Interactive components not working

**Pattern:** Dialog, Dropdown, etc. don't respond

**Example:**
```astro
<Dialog>
  <DialogContent>...</DialogContent>  <!-- Missing client:load -->
</Dialog>
```

**Fix strategy:**
1. Identify interactive components
2. Check if `client:load` or `client:visible` is present
3. Add appropriate client directive
4. Verify component still works after fix

---

### 7. Visual quality issues

**Pattern:** Looks generic, bad spacing, wrong colors

**Example feedback:**
- "Too much whitespace"
- "Buttons all look the same"
- "Colors don't match brand"

**Fix strategy:**
1. Read quality feedback carefully
2. Identify specific issues (spacing, color, etc.)
3. Make targeted adjustments:
   - Spacing: Adjust `py-`, `gap-` values
   - Colors: Ensure semantic tokens used
   - Variety: Use different button variants, card styles
4. Re-generate section if major rework needed

---

### 8. Semantic HTML issues

**Pattern:** Divs instead of semantic tags

**Example:**
```astro
<!-- Bad -->
<div class="header">...</div>
<div class="nav">...</div>

<!-- Good -->
<header>...</header>
<nav>...</nav>
```

**Fix strategy:**
1. Identify non-semantic elements
2. Map to correct semantic tags:
   - `div.header` → `<header>`
   - `div.nav` → `<nav>`
   - `div.footer` → `<footer>`
   - `div.main` → `<main>`
   - `div.section` → `<section>`
3. Update file with semantic tags

---

## Fix strategy by severity

### Minor issues (surgical fix)
- Wrong Tailwind class value
- Missing client directive
- Spacing adjustment
- Color class fix

**Use Edit tool** for precise changes.

### Moderate issues (section re-generation)
- Missing section
- Wrong component in section
- Layout completely wrong

**Re-generate section** with specific prompt.

### Major issues (file re-generation)
- Multiple sections wrong
- Content mapping completely broken
- File structure doesn't match brief

**Re-generate entire file** with current code + errors context.

---

## Retry prompts

### Retry 1 prompt
```
Fix the errors in [file].

CURRENT CODE:
[paste current code]

ERRORS:
[list specific errors]

DESIGN BRIEF:
[paste relevant brief section]

Generate the corrected file.
```

### Retry 2 prompt (if retry 1 failed)
```
Re-generate [file] from scratch. Previous fixes didn't work.

DESIGN BRIEF FOR THIS FILE:
[paste full brief]

ERRORS THAT PERSISTED:
[list errors]

Start fresh and generate the file correctly.
```

### Flag for human review
```
File [file] failed after 2 retries.

ERRORS:
[persistent errors]

RECOMMENDATION:
[what you tried, what might help]

Flagging for human review.
```
