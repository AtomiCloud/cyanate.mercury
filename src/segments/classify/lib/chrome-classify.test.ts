import { describe, expect, it } from "bun:test";
import {
	buildClassifierPrompt,
	buildReviewerPrompt,
	type ClassifierOutput,
	classifyOnePage,
	collectArrayLengths,
	type PageClassifyInput,
	parseChromeReviewerVerdict,
	parseClassifierOutput,
	type RunAgentFn,
	validateClassifierOutput,
} from "./chrome-classify.js";

const page: PageClassifyInput = {
	pagetype: "service",
	url: "/sports-physio/",
	content: {
		header: {
			logo: { src: "/logo.svg", alt: "Acme" },
			nav: { links: [{ href: "/", label: "Home" }] },
		},
		title: "Sports Physio",
		body: { copy: "Lorem ipsum." },
	},
};

// ---------------------------------------------------------------------------
// parseClassifierOutput
// ---------------------------------------------------------------------------

describe("parseClassifierOutput", () => {
	it("parses a well-formed object", () => {
		const raw = '{"chromePaths":[{"sourcePath":"header.logo.src"}]}';
		expect(parseClassifierOutput(raw)).toEqual({
			chromePaths: [{ sourcePath: "header.logo.src" }],
		});
	});

	it("keeps suggestedCanonical when string", () => {
		const raw =
			'{"chromePaths":[{"sourcePath":"header.logo.src","suggestedCanonical":"header.brand.logo.src"}]}';
		expect(parseClassifierOutput(raw)).toEqual({
			chromePaths: [
				{
					sourcePath: "header.logo.src",
					suggestedCanonical: "header.brand.logo.src",
				},
			],
		});
	});

	it("extracts a JSON object from surrounding prose", () => {
		const raw = `here you go:\n\n{"chromePaths":[]}\n\nhope that helps`;
		expect(parseClassifierOutput(raw)).toEqual({ chromePaths: [] });
	});

	it("rejects non-array chromePaths", () => {
		expect(parseClassifierOutput('{"chromePaths":"nope"}')).toBeNull();
	});

	it("rejects entries missing sourcePath", () => {
		expect(parseClassifierOutput('{"chromePaths":[{"x":1}]}')).toBeNull();
	});

	it("rejects non-string sourcePath", () => {
		expect(
			parseClassifierOutput('{"chromePaths":[{"sourcePath":123}]}'),
		).toBeNull();
	});

	it("rejects non-string suggestedCanonical", () => {
		expect(
			parseClassifierOutput(
				'{"chromePaths":[{"sourcePath":"a","suggestedCanonical":7}]}',
			),
		).toBeNull();
	});

	it("returns null for raw text without JSON", () => {
		expect(parseClassifierOutput("no json here")).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseClassifierOutput('{"chromePaths":[}')).toBeNull();
	});

	it("handles strings containing braces inside the JSON payload", () => {
		const raw =
			'{"chromePaths":[{"sourcePath":"a{b}","suggestedCanonical":"x"}]}';
		expect(parseClassifierOutput(raw)).toEqual({
			chromePaths: [{ sourcePath: "a{b}", suggestedCanonical: "x" }],
		});
	});
});

// ---------------------------------------------------------------------------
// validateClassifierOutput
// ---------------------------------------------------------------------------

describe("validateClassifierOutput", () => {
	it("accepts paths resolving to leaves", () => {
		const out: ClassifierOutput = {
			chromePaths: [
				{ sourcePath: "header.logo.src" },
				{ sourcePath: "header.nav.links[0].label" },
			],
		};
		expect(validateClassifierOutput(page.content, out)).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("rejects paths that don't resolve", () => {
		const out: ClassifierOutput = {
			chromePaths: [{ sourcePath: "header.missing" }],
		};
		const result = validateClassifierOutput(page.content, out);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("does not resolve");
	});

	it("rejects paths pointing at non-empty containers", () => {
		const out: ClassifierOutput = {
			chromePaths: [{ sourcePath: "header" }],
		};
		const result = validateClassifierOutput(page.content, out);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("non-empty container");
	});

	it("rejects duplicates", () => {
		const out: ClassifierOutput = {
			chromePaths: [{ sourcePath: "title" }, { sourcePath: "title" }],
		};
		const result = validateClassifierOutput(page.content, out);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Duplicate");
	});

	it("rejects empty sourcePath", () => {
		const out: ClassifierOutput = { chromePaths: [{ sourcePath: "" }] };
		expect(validateClassifierOutput(page.content, out).valid).toBe(false);
	});

	it("rejects bad characters in suggestedCanonical", () => {
		const out: ClassifierOutput = {
			chromePaths: [{ sourcePath: "title", suggestedCanonical: "has spaces" }],
		};
		const result = validateClassifierOutput(page.content, out);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("suggestedCanonical");
	});

	it("accepts empty chromePaths list", () => {
		expect(
			validateClassifierOutput(page.content, { chromePaths: [] }).valid,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseChromeReviewerVerdict
// ---------------------------------------------------------------------------

describe("parseChromeReviewerVerdict", () => {
	it("parses PASS", () => {
		expect(parseChromeReviewerVerdict("VERDICT: PASS").verdict).toBe("pass");
	});

	it("parses REJECT and extracts rejection context", () => {
		const v = parseChromeReviewerVerdict(
			"VERDICT: REJECT\nfooter missing.\nREJECTION CONTEXT:\nadd footer.copyright to chrome",
		);
		expect(v.verdict).toBe("reject");
		expect(v.rejectionContext).toBe("add footer.copyright to chrome");
	});

	it("falls back to reject for malformed verdict", () => {
		expect(parseChromeReviewerVerdict("lgtm").verdict).toBe("reject");
	});
});

// ---------------------------------------------------------------------------
// Prompts — smoke tests (not content-graded)
// ---------------------------------------------------------------------------

describe("buildClassifierPrompt", () => {
	it("includes the page content + definition", () => {
		const p = buildClassifierPrompt(page);
		expect(p).toContain("Chrome definition");
		expect(p).toContain("Sports Physio");
		expect(p).toContain('"chromePaths"');
	});

	it("leads with the JSON-only preamble", () => {
		const p = buildClassifierPrompt(page);
		expect(p).toContain("JSON-only classifier");
		expect(p).toContain("JSON.parse");
	});

	it("embeds array lengths with valid index ranges", () => {
		const p = buildClassifierPrompt(page);
		expect(p).toContain("Array lengths");
		expect(p).toContain("header.nav.links: length 1 (valid indices: 0..0)");
	});

	it("appends rejection context when provided", () => {
		const p = buildClassifierPrompt(page, "fix the duplicate");
		expect(p).toContain("PREVIOUS ATTEMPT REJECTED");
		expect(p).toContain("fix the duplicate");
	});
});

describe("collectArrayLengths", () => {
	it("collects nested array lengths with dot/bracket paths", () => {
		const entries = collectArrayLengths({
			a: { b: [1, 2, 3] },
			c: [{ d: [10] }, { d: [] }],
		});
		const map = new Map(entries.map((e) => [e.path, e.length]));
		expect(map.get("a.b")).toBe(3);
		expect(map.get("c")).toBe(2);
		expect(map.get("c[0].d")).toBe(1);
		expect(map.get("c[1].d")).toBe(0);
	});

	it("returns empty for objects with no arrays", () => {
		expect(collectArrayLengths({ a: 1, b: { c: "x" } })).toEqual([]);
	});
});

describe("buildReviewerPrompt", () => {
	it("includes page + candidate + verdict format", () => {
		const candidate: ClassifierOutput = {
			chromePaths: [{ sourcePath: "header.logo.src" }],
		};
		const p = buildReviewerPrompt(page, candidate);
		expect(p).toContain("VERDICT: PASS");
		expect(p).toContain("VERDICT: REJECT");
		expect(p).toContain("Sports Physio");
		expect(p).toContain("header.logo.src");
	});
});

// ---------------------------------------------------------------------------
// classifyOnePage — full orchestration with a stub runAgent
// ---------------------------------------------------------------------------

interface StubCall {
	role: "classify" | "review";
	output: string;
}

function stubAgent(calls: StubCall[]): RunAgentFn {
	let i = 0;
	return async ({ role }) => {
		const call = calls[i++];
		if (!call)
			throw new Error(`no more stubbed calls for ${role} at index ${i}`);
		if (call.role !== role) {
			throw new Error(
				`role mismatch at call ${i}: expected ${call.role}, got ${role}`,
			);
		}
		return {
			output: call.output,
			turns: 1,
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
		};
	};
}

describe("classifyOnePage", () => {
	it("passes on first try when classifier + reviewer agree", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"header.logo.src"}]}',
				},
				{ role: "review", output: "VERDICT: PASS" },
			]),
			maxRetries: 2,
		});
		expect(result.status).toBe("pass");
		expect(result.output?.chromePaths).toHaveLength(1);
		expect(result.attempts).toHaveLength(1);
		expect(result.totals.turns).toBe(2);
		expect(result.totals.inputTokens).toBe(200);
		expect(result.totals.cost).toBeCloseTo(0.002, 6);
	});

	it("retries on unparseable classifier output", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{ role: "classify", output: "not JSON" },
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"title"}]}',
				},
				{ role: "review", output: "VERDICT: PASS" },
			]),
			maxRetries: 2,
		});
		expect(result.status).toBe("pass");
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0].classify.error).toBe("unparseable");
		expect(result.attempts[0].review).toBeUndefined();
		expect(result.attempts[1].review?.verdict).toBe("pass");
	});

	it("retries on validator fail (invalid path)", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"nope.missing"}]}',
				},
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"title"}]}',
				},
				{ role: "review", output: "VERDICT: PASS" },
			]),
			maxRetries: 2,
		});
		expect(result.status).toBe("pass");
		expect(result.attempts[0].classify.error).toContain("does not resolve");
	});

	it("retries on reviewer REJECT", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"title"}]}',
				},
				{
					role: "review",
					output:
						"VERDICT: REJECT\ntitle is body not chrome.\nREJECTION CONTEXT:\nremove title; add header.logo.src",
				},
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"header.logo.src"}]}',
				},
				{ role: "review", output: "VERDICT: PASS" },
			]),
			maxRetries: 2,
		});
		expect(result.status).toBe("pass");
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0].review?.verdict).toBe("reject");
		expect(result.attempts[1].review?.verdict).toBe("pass");
	});

	it("fails when retries are exhausted", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{ role: "classify", output: "bad 1" },
				{ role: "classify", output: "bad 2" },
				{ role: "classify", output: "bad 3" },
			]),
			maxRetries: 2,
		});
		expect(result.status).toBe("fail");
		expect(result.attempts).toHaveLength(3);
		expect(result.lastRejection).toBeDefined();
	});

	it("sums token metrics across all sub-calls (success + retries)", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{ role: "classify", output: "bad" },
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"title"}]}',
				},
				{ role: "review", output: "VERDICT: PASS" },
			]),
			maxRetries: 2,
		});
		// 3 agent calls × (100 in + 50 out + $0.001) each
		expect(result.totals.inputTokens).toBe(300);
		expect(result.totals.outputTokens).toBe(150);
		expect(result.totals.turns).toBe(3);
		expect(result.totals.cost).toBeCloseTo(0.003, 6);
	});

	it("records classify prompt/response on every attempt and review only when reached", async () => {
		const result = await classifyOnePage({
			page,
			runAgent: stubAgent([
				{ role: "classify", output: "not JSON" },
				{
					role: "classify",
					output: '{"chromePaths":[{"sourcePath":"title"}]}',
				},
				{ role: "review", output: "VERDICT: PASS" },
			]),
			maxRetries: 2,
		});
		expect(result.attempts).toHaveLength(2);
		// Attempt 0 never reaches review (unparseable output).
		expect(result.attempts[0].classify.prompt).toContain("Chrome definition");
		expect(result.attempts[0].classify.response).toBe("not JSON");
		expect(result.attempts[0].classify.parsed).toBeUndefined();
		expect(result.attempts[0].review).toBeUndefined();
		// Attempt 1 reaches review.
		expect(result.attempts[1].classify.parsed?.chromePaths).toHaveLength(1);
		expect(result.attempts[1].review?.prompt).toContain(
			"Candidate classification",
		);
		expect(result.attempts[1].review?.response).toContain("VERDICT: PASS");
		expect(result.attempts[1].review?.verdict).toBe("pass");
	});
});
