/**
 * Playwright utilities — IO browser automation helpers.
 */

import { join } from "node:path";
import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// IO shell — browser automation
// ---------------------------------------------------------------------------

/**
 * Launch a browser with the default Playwright config.
 * Respects PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var (set by nix shell).
 */
export async function launchBrowser(): Promise<
	import("@playwright/test").Browser
> {
	const { chromium } = await import("@playwright/test");
	const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
	return chromium.launch({
		headless: true,
		...(executablePath ? { executablePath } : {}),
	});
}

/**
 * Screenshot a page at multiple viewports.
 * @param outputDir - Optional directory to write screenshots into. Defaults to CWD.
 * @param colorScheme - Optional color scheme to emulate before navigation.
 */
export async function screenshotAtViewports(
	page: Page,
	route: string,
	viewports = [
		{ name: "mobile", width: 375, height: 812 },
		{ name: "tablet", width: 768, height: 1024 },
		{ name: "desktop", width: 1440, height: 720 },
	],
	outputDir?: string,
	colorScheme?: "light" | "dark",
): Promise<Array<{ viewport: string; path: string }>> {
	if (colorScheme) {
		await page.emulateMedia({ colorScheme });
	}

	const results: Array<{ viewport: string; path: string }> = [];

	for (const vp of viewports) {
		await page.setViewportSize({ width: vp.width, height: vp.height });
		await page.goto(route, { waitUntil: "networkidle" });
		const routeSlug = route === "/" ? "root" : route.replace(/\//g, "-");
		const filename = `screenshot-${routeSlug}-${vp.name}-${vp.width}x${vp.height}${colorScheme ? `-${colorScheme}` : ""}.png`;
		const path = outputDir ? join(outputDir, filename) : filename;
		await page.screenshot({ path, fullPage: true });
		results.push({ viewport: vp.name, path });
	}

	return results;
}

/**
 * Capture all console messages during a single page navigation.
 * The listener is automatically removed after navigation completes,
 * so repeated calls on the same page do not accumulate listeners.
 */
export async function captureConsoleErrors(
	page: Page,
	route: string,
): Promise<Array<{ type: string; text: string }>> {
	const messages: Array<{ type: string; text: string }> = [];

	const handler = (msg: import("@playwright/test").ConsoleMessage) => {
		messages.push({ type: msg.type(), text: msg.text() });
	};
	page.on("console", handler);

	try {
		await page.goto(route, { waitUntil: "networkidle" });
	} finally {
		page.off("console", handler);
	}

	return messages;
}
