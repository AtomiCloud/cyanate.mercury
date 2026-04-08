import { describe, expect, test } from "bun:test";
import {
	categorizeConsoleMessages,
	parseComputedStyles,
	parseCssCustomProperties,
	recordPseudoClassState,
} from "./playwright-utils.js";

// ---------------------------------------------------------------------------
// parseComputedStyles
// ---------------------------------------------------------------------------

describe("parseComputedStyles", () => {
	test("filters relevant design properties from raw map", () => {
		const raw: Record<string, string> = {
			"font-size": "16px",
			"font-family": "Inter, sans-serif",
			color: "rgb(0, 0, 0)",
			"background-color": "white",
			"border-radius": "8px",
			padding: "16px",
			display: "block",
			position: "relative",
			// These should be filtered out
			"align-content": "stretch",
			"animation-delay": "0s",
		};
		const result = parseComputedStyles(raw);
		expect(result["font-size"]).toBe("16px");
		expect(result["font-family"]).toBe("Inter, sans-serif");
		expect(result.color).toBe("rgb(0, 0, 0)");
		expect(result["background-color"]).toBe("white");
		expect(result["border-radius"]).toBe("8px");
		expect(result.padding).toBe("16px");
		expect(result.display).toBe("block");
		expect(result.position).toBe("relative");
	});

	test("empty input → empty output", () => {
		expect(parseComputedStyles({})).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// parseCssCustomProperties
// ---------------------------------------------------------------------------

describe("parseCssCustomProperties", () => {
	test("parses custom properties from single sheet", () => {
		const sheets = [
			`
					:root {
						--color-primary: oklch(0.5 0.1 180);
						--color-secondary: oklch(0.6 0.15 260);
						--spacing-unit: 0.25rem;
					}
				`,
		];
		const result = parseCssCustomProperties(sheets);
		expect(result["--color-primary"]).toBe("oklch(0.5 0.1 180)");
		expect(result["--color-secondary"]).toBe("oklch(0.6 0.15 260)");
		expect(result["--spacing-unit"]).toBe("0.25rem");
	});

	test("handles multiple sheets", () => {
		const sheets = [":root { --a: 1px; --b: 2px; }", ":root { --c: 3px; }"];
		const result = parseCssCustomProperties(sheets);
		expect(result["--a"]).toBe("1px");
		expect(result["--b"]).toBe("2px");
		expect(result["--c"]).toBe("3px");
	});

	test("handles empty input", () => {
		expect(parseCssCustomProperties([])).toEqual({});
		expect(parseCssCustomProperties(["no properties here"])).toEqual({});
	});

	test("handles whitespace variations", () => {
		const sheets = [":root{--tight:0px;--normal:1rem}"];
		const result = parseCssCustomProperties(sheets);
		expect(result["--tight"]).toBe("0px");
		expect(result["--normal"]).toBe("1rem");
	});
});

// ---------------------------------------------------------------------------
// categorizeConsoleMessages
// ---------------------------------------------------------------------------

describe("categorizeConsoleMessages", () => {
	test("mixed messages → correct buckets", () => {
		const messages = [
			{ type: "error", text: "Failed to load asset" },
			{ type: "warning", text: "Deprecation notice" },
			{ type: "log", text: "Page loaded" },
			{ type: "error", text: "Network error" },
			{ type: "info", text: "User info" },
		];
		const result = categorizeConsoleMessages(messages);
		expect(result.errors).toEqual(["Failed to load asset", "Network error"]);
		expect(result.warnings).toEqual(["Deprecation notice"]);
		expect(result.info).toEqual(["Page loaded", "User info"]);
	});

	test("unknown types → info bucket", () => {
		const messages = [
			{ type: "debug", text: "debug msg" },
			{ type: "something-weird", text: "weird msg" },
		];
		const result = categorizeConsoleMessages(messages);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.info).toEqual(["debug msg", "weird msg"]);
	});

	test("empty input → empty buckets", () => {
		const result = categorizeConsoleMessages([]);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.info).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// recordPseudoClassState
// ---------------------------------------------------------------------------

describe("recordPseudoClassState", () => {
	test("records styles under the correct key and pseudo", () => {
		const acc: Record<string, Record<string, Record<string, string>>> = {};
		const styles = { color: "red", "background-color": "blue" };
		recordPseudoClassState(acc, "button.primary[0]", ":hover", styles);
		expect(acc["button.primary[0]"]).toEqual({ ":hover": styles });
	});

	test("accumulates multiple pseudo states for the same element", () => {
		const acc: Record<string, Record<string, Record<string, string>>> = {};
		recordPseudoClassState(acc, "a.nav[1]", ":hover", { color: "red" });
		recordPseudoClassState(acc, "a.nav[1]", ":focus", { color: "blue" });
		recordPseudoClassState(acc, "a.nav[1]", ":active", { color: "green" });
		expect(acc["a.nav[1]"][":hover"]).toEqual({ color: "red" });
		expect(acc["a.nav[1]"][":focus"]).toEqual({ color: "blue" });
		expect(acc["a.nav[1]"][":active"]).toEqual({ color: "green" });
	});

	test("handles multiple elements independently", () => {
		const acc: Record<string, Record<string, Record<string, string>>> = {};
		recordPseudoClassState(acc, "button[0]", ":hover", { opacity: "0.8" });
		recordPseudoClassState(acc, "button[1]", ":hover", { opacity: "0.9" });
		expect(acc["button[0]"][":hover"]).toEqual({ opacity: "0.8" });
		expect(acc["button[1]"][":hover"]).toEqual({ opacity: "0.9" });
	});
});
