/**
 * Playwright utilities — pure data transforms and IO browser automation helpers.
 *
 * Pure helpers (no IO): parseComputedStyles, parseCssCustomProperties, categorizeConsoleMessages
 * IO shell (browser side-effects): all other exported functions
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Pure data transforms
// ---------------------------------------------------------------------------

export interface StyleMap {
	[key: string]: string;
}

/**
 * Parse raw getComputedStyle output into a structured token map.
 * Filters out longhand properties and keeps design-relevant tokens.
 */
export function parseComputedStyles(raw: Record<string, string>): StyleMap {
	const tokens: StyleMap = {};
	const relevantPrefixes = [
		"color",
		"background",
		"font",
		"border",
		"padding",
		"margin",
		"gap",
		"spacing",
		"border-radius",
		"box-shadow",
		"opacity",
		"line-height",
		"letter-spacing",
		"text-transform",
		"text-decoration",
		"max-width",
		"min-height",
		"transition",
		"transform",
		"overflow",
		"display",
		"position",
		"z-index",
		"width",
		"height",
	];

	for (const [key, value] of Object.entries(raw)) {
		if (relevantPrefixes.some((p) => key.startsWith(p))) {
			tokens[key] = value;
		}
	}

	return tokens;
}

/**
 * Parse CSS custom properties from raw stylesheet text.
 * Extracts --property-name: value pairs.
 */
export function parseCssCustomProperties(
	rawSheets: string[],
): Record<string, string> {
	const result: Record<string, string> = {};
	const customPropRegex = /--([a-zA-Z0-9-_]+)\s*:\s*([^;{}\n]+)/g;

	for (const sheet of rawSheets) {
		const matches = sheet.matchAll(customPropRegex);
		for (const match of matches) {
			result[`--${match[1]}`] = match[2].trim();
		}
	}

	return result;
}

/**
 * Categorize console messages by severity.
 */
export function categorizeConsoleMessages(
	messages: Array<{ type: string; text: string }>,
): { errors: string[]; warnings: string[]; info: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const info: string[] = [];

	for (const msg of messages) {
		switch (msg.type) {
			case "error":
				errors.push(msg.text);
				break;
			case "warning":
				warnings.push(msg.text);
				break;
			default:
				info.push(msg.text);
				break;
		}
	}

	return { errors, warnings, info };
}

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
 * Extract computed styles from all elements on a page.
 */
export async function extractComputedStyles(
	page: Page,
	selector = "body *",
): Promise<Record<string, Record<string, string>>> {
	return page.evaluate((sel: string) => {
		const elements = document.querySelectorAll(sel);
		const result: Record<string, Record<string, string>> = {};
		const style = window.getComputedStyle(document.documentElement);
		const props: string[] = [];
		for (let i = 0; i < style.length; i++) {
			props.push(style[i]);
		}

		elements.forEach((el, idx) => {
			const computed = window.getComputedStyle(el);
			const entry: Record<string, string> = {};
			for (const prop of props) {
				const val = computed.getPropertyValue(prop);
				if (val) entry[prop] = val;
			}
			const tag = el.tagName.toLowerCase();
			const cls = el.className
				? `.${String(el.className).split(" ").slice(0, 2).join(".")}`
				: "";
			result[`${tag}${cls}[${idx}]`] = entry;
		});

		return result;
	}, selector);
}

/**
 * Extract CSS custom properties from all stylesheets on a page.
 */
export async function extractCssCustomProperties(
	page: Page,
): Promise<Record<string, string>> {
	const sheets = await page.evaluate(() => {
		return Array.from(document.styleSheets).map((sheet) => {
			try {
				return Array.from(sheet.cssRules)
					.map((rule) => rule.cssText)
					.join("\n");
			} catch {
				return "";
			}
		});
	});

	return parseCssCustomProperties(sheets);
}

/**
 * Extract transition/animation definitions from computed styles.
 */
export async function extractTransitions(
	page: Page,
): Promise<Record<string, string>> {
	return page.evaluate(() => {
		const result: Record<string, string> = {};
		const elements = document.querySelectorAll("body *");
		elements.forEach((el, idx) => {
			const computed = window.getComputedStyle(el);
			const transition = computed.transition;
			const animation = computed.animation;
			if (transition && transition !== "all 0s ease 0s") {
				const tag = el.tagName.toLowerCase();
				result[`${tag}[${idx}].transition`] = transition;
			}
			if (
				animation &&
				animation !== "none 0s ease 0s normal none running none"
			) {
				const tag = el.tagName.toLowerCase();
				result[`${tag}[${idx}].animation`] = animation;
			}
		});
		return result;
	});
}

// ---------------------------------------------------------------------------
// Pseudo style extraction
// ---------------------------------------------------------------------------

/** Pseudo-element selectors extracted via getComputedStyle. */
const PSEUDO_ELEMENTS = ["::before", "::after"] as const;

/** CSS properties to collect from pseudo styles. */
const PSEUDO_PROPS = [
	"content",
	"color",
	"background-color",
	"border",
	"padding",
	"margin",
	"opacity",
	"transform",
	"transition",
	"box-shadow",
	"text-decoration",
	"font-size",
	"display",
] as const;

/** Selector for interactive elements (buttons, links, inputs, focusable elements). */
const INTERACTIVE_SELECTOR =
	"a, button, input, textarea, select, [tabindex], [role='button'], [role='link'], summary, details";

/** Type alias for an element handle pointing to an Element node. */
type ElHandle = import("@playwright/test").ElementHandle<Element>;

/**
 * Read computed styles for a set of properties on a specific element handle.
 * Uses el.evaluate() to target the exact element (not a querySelector).
 */
async function readElementStyles(
	el: ElHandle,
	props: readonly string[],
): Promise<Record<string, string> | null> {
	return el.evaluate(
		(e, propList) => {
			const c = window.getComputedStyle(e);
			const entry: Record<string, string> = {};
			for (const prop of propList) {
				const val = c.getPropertyValue(prop);
				if (val) entry[prop] = val;
			}
			return Object.keys(entry).length > 0 ? entry : null;
		},
		[...props],
	);
}

/**
 * Build a unique element key from tag name and class list.
 */
async function buildElementKey(el: ElHandle, idx: number): Promise<string> {
	const parts = await el.evaluate((e) => {
		const tag = e.tagName.toLowerCase();
		const cls = e.className
			? `.${String(e.className).split(" ").slice(0, 2).join(".")}`
			: "";
		return { tag, cls };
	});
	return `${parts.tag}${parts.cls}[${idx}]`;
}

/** Record a pseudo-class state result into the accumulator map. */
export function recordPseudoClassState(
	acc: Record<string, Record<string, Record<string, string>>>,
	key: string,
	pseudo: string,
	styles: Record<string, string>,
): void {
	if (!acc[key]) acc[key] = {};
	acc[key][pseudo] = styles;
}

/**
 * Extract :hover styles by moving the mouse over the element.
 */
async function extractHoverStyles(
	page: Page,
	el: ElHandle,
	key: string,
	acc: Record<string, Record<string, Record<string, string>>>,
): Promise<void> {
	await el.hover();
	const styles = await readElementStyles(el, PSEUDO_PROPS);
	if (styles) {
		recordPseudoClassState(acc, key, ":hover", styles);
	}
	await page.mouse.move(0, 0);
}

/**
 * Extract :focus styles by focusing the element.
 */
async function extractFocusStyles(
	el: ElHandle,
	key: string,
	acc: Record<string, Record<string, Record<string, string>>>,
): Promise<void> {
	await el.focus();
	const styles = await readElementStyles(el, PSEUDO_PROPS);
	if (styles) {
		recordPseudoClassState(acc, key, ":focus", styles);
	}
	await el.evaluate((e) => (e as HTMLElement).blur());
}

/**
 * Extract :active styles by dispatching mousedown inside a single evaluate tick,
 * then reading computed styles while the :active pseudo-class is applied.
 */
async function extractActiveStyles(
	page: Page,
	el: ElHandle,
	key: string,
	acc: Record<string, Record<string, Record<string, string>>>,
): Promise<void> {
	const box = await el.boundingBox();
	if (!box) return;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	const styles = await el.evaluate(
		(e, propList) => {
			e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			const c = window.getComputedStyle(e);
			const entry: Record<string, string> = {};
			for (const prop of propList) {
				const val = c.getPropertyValue(prop);
				if (val) entry[prop] = val;
			}
			e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			return Object.keys(entry).length > 0 ? entry : null;
		},
		[...PSEUDO_PROPS],
	);
	if (styles) {
		recordPseudoClassState(acc, key, ":active", styles);
	}
}

/**
 * Collect pseudo-class styles for all interactive elements on the page.
 * Drives each element through :hover, :focus, and :active states.
 */
async function collectPseudoClassStyles(
	page: Page,
	selector: string,
): Promise<Record<string, Record<string, Record<string, string>>>> {
	const acc: Record<string, Record<string, Record<string, string>>> = {};
	const interactiveElements = (await page.$$(selector)) as ElHandle[];

	for (let i = 0; i < interactiveElements.length; i++) {
		const el = interactiveElements[i];
		const key = await buildElementKey(el, i);

		try {
			await extractHoverStyles(page, el, key, acc);
		} catch {
			// Element may not be visible or hoverable
		}

		try {
			await extractFocusStyles(el, key, acc);
		} catch {
			// Element may not be focusable
		}

		try {
			await extractActiveStyles(page, el, key, acc);
		} catch {
			// Element may not be clickable or visible
		}
	}

	return acc;
}

/**
 * Extract pseudo-element and pseudo-class styles from elements on a page.
 *
 * Pseudo-elements (::before, ::after): uses getComputedStyle(el, pseudo) —
 * these are always accessible because pseudo-elements don't require interactive state.
 *
 * Pseudo-classes (:hover, :focus, :active): drives elements into the
 * interactive state via Playwright actions (hover/focus/dispatchEvent),
 * then reads getComputedStyle(el) on the specific element handle to capture
 * the applied styles. Only targets interactive elements.
 */
export async function extractPseudoStyles(
	page: Page,
): Promise<Record<string, Record<string, Record<string, string>>>> {
	const arg = { elements: PSEUDO_ELEMENTS, props: PSEUDO_PROPS };
	type Arg = typeof arg;

	// Phase 1: Extract pseudo-element styles (::before, ::after) via getComputedStyle
	const pseudoElementStyles = await page.evaluate(
		({ elements, props }: Arg) => {
			function elementKey(el: Element, idx: number): string {
				const tag = el.tagName.toLowerCase();
				const cls = el.className
					? `.${String(el.className).split(" ").slice(0, 2).join(".")}`
					: "";
				return `${tag}${cls}[${idx}]`;
			}

			function singlePseudo(
				el: Element,
				pseudo: string,
			): Record<string, string> | undefined {
				try {
					const c = window.getComputedStyle(el, pseudo);
					const entry: Record<string, string> = {};
					for (const prop of props) {
						const val = c.getPropertyValue(prop);
						if (val) entry[prop] = val;
					}
					return Object.keys(entry).length > 0 ? entry : undefined;
				} catch {
					return undefined;
				}
			}

			const result: Record<string, Record<string, Record<string, string>>> = {};
			const els = document.querySelectorAll("body *");
			for (let idx = 0; idx < els.length; idx++) {
				const out: Record<string, Record<string, string>> = {};
				for (const pseudo of elements) {
					const entry = singlePseudo(els[idx], pseudo);
					if (entry) out[pseudo] = entry;
				}
				if (Object.keys(out).length > 0) {
					result[elementKey(els[idx], idx)] = out;
				}
			}
			return result;
		},
		arg,
	);

	// Phase 2: Extract pseudo-class styles (:hover, :focus, :active)
	const pseudoClassStyles = await collectPseudoClassStyles(
		page,
		INTERACTIVE_SELECTOR,
	);

	return { ...pseudoElementStyles, ...pseudoClassStyles };
}

/**
 * Inject culori for OKLCH color parsing in the browser context.
 * Loads the bundled culori script from the locally installed package.
 */
export async function injectCulori(page: Page): Promise<void> {
	const require = createRequire(import.meta.url);
	const pkgDir = join(require.resolve("culori/package.json"), "..");
	const culoriPath = join(pkgDir, "bundled/culori.min.js");
	const content = readFileSync(culoriPath, "utf-8");
	await page.addScriptTag({ content });
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

/**
 * Visit all routes in a list, returning console errors per route.
 */
export async function visitAllRoutes(
	routes: string[],
	baseUrl: string,
): Promise<
	Record<string, { errors: string[]; warnings: string[]; info: string[] }>
> {
	const browser = await launchBrowser();
	const context = await browser.newContext();
	const page = await context.newPage();
	const results: Record<
		string,
		{ errors: string[]; warnings: string[]; info: string[] }
	> = {};

	for (const route of routes) {
		const url = route.startsWith("http") ? route : `${baseUrl}${route}`;
		const messages = await captureConsoleErrors(page, url);
		results[route] = categorizeConsoleMessages(messages);
	}

	await browser.close();
	return results;
}

/**
 * Create an isolated browser context (no shared cookies/storage).
 */
export async function createIsolatedContext(): Promise<{
	context: import("@playwright/test").BrowserContext;
	page: import("@playwright/test").Page;
	close: () => Promise<void>;
}> {
	const browser = await launchBrowser();
	const context = await browser.newContext();
	const page = await context.newPage();
	return {
		context,
		page,
		close: () => browser.close(),
	};
}
