/**
 * Step 6: Functional Check
 * Test links, buttons, and pages using Playwright.
 */

import { writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery, extractErrors } from '../lib/agent.js';

export const functionalCheckStep: Step = {
  id: 'functional-check',
  name: 'Functional Check',
  description: 'Test links, buttons, and pages work correctly',
  modifiesSite: false,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const prompt = `Use the **webapp-testing** skill to test the Astro project at the current directory.

IMPORTANT: Start the dev server first with: npm run dev

## Functional Checks

Run the following tests using Playwright:

1. **Page Load Test**
   - Visit the homepage (http://localhost:4321)
   - Check the page loads without crash
   - Check for console errors (Error level only, ignore warnings)

2. **Link Checker**
   - Find all links on the homepage
   - Visit each link and verify it returns 200 or navigates correctly
   - Check for any 404 errors
   - Report broken links

3. **Navigation Test**
   - Click on main navigation links
   - Verify they navigate to correct pages
   - Check that all nav items work

4. **Button Test**
   - Find all buttons on the homepage
   - Click each button
   - Verify buttons are clickable (not disabled)
   - Report any broken buttons

5. **All Pages Test**
   - Visit each page defined in src/pages/
   - Verify each page loads without crash
   - Report any pages that fail to load

For each check:
- If pass, note it
- If fail, list the specific link/button/page that failed

Output format:
- If all checks pass: "FUNCTIONAL_CHECK_PASSED"
- If any check fails: List the failures clearly

DO NOT take screenshots unless explicitly asked. Focus on functional verification.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('FUNCTIONAL_CHECK_PASSED');

    await writeFile(
      `${workingDir}/functional-report.json`,
      JSON.stringify({
        passed,
        errors: passed ? [] : extractErrors(result),
        rawOutput: result.slice(0, 5000),
      }, null, 2),
      'utf-8',
    );

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : 'Functional check failed',
    };
  },
};
