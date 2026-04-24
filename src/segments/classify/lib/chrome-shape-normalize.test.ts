import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ClassifierOutput,
	ClassifierPathEntry,
	RunAgentFn,
} from "./chrome-classify.js";
import { materializeShapeNormalizedChrome } from "./chrome-shape-materialize.js";
import {
	applyArrayRepresentationBaseline,
	applyShapeNormalizeOps,
	buildShapeNormalizePrompt,
	buildShapeNormalizeReviewerPrompt,
	deriveShapeNormalizeOps,
	parseShapeNormalizeIntentOutput,
	parseShapeNormalizeOpsOutput,
	SHAPE_NORMALIZE_PASSES,
	shapeNormalizeOnePage,
	validateShapeNormalizeIntents,
	validateShapeNormalizeOps,
	validateShapeNormalizeOutput,
} from "./chrome-shape-normalize.js";

const chromePaths: ClassifierPathEntry[] = [
	{ sourcePath: "header.logo.url" },
	{ sourcePath: "header.logo.alt" },
	{ sourcePath: "footer.contact_form.email_placeholder" },
];

const page = {
	pagetype: "service",
	url: "/sports-physio/",
	content: {
		header: {
			logo: {
				url: "/logo.svg",
				alt: "Acme",
			},
		},
		footer: {
			contact_form: {
				email_placeholder: "Email",
			},
		},
	},
	chrome: {
		header: {
			logo: {
				url: "/logo.svg",
				alt: "Acme",
			},
		},
		footer: {
			contact_form: {
				email_placeholder: "Email",
			},
		},
	},
	chromePaths,
};

function testOpsWorkdir(name: string): string {
	return join(tmpdir(), `mecury-shape-ops-${process.pid}-${name}`);
}

const emptyOps = JSON.stringify({ ops: [] });
const emptyIntents = JSON.stringify({ intents: [] });

function setOps(...ops: Array<{ sourcePath: string; to: string }>): string {
	return JSON.stringify({
		ops: ops.map((op) => ({
			kind: "set-suggested-canonical",
			sourcePath: op.sourcePath,
			toSuggestedCanonical: op.to,
			reason: "test normalization",
		})),
	});
}

function clearOps(...sourcePaths: string[]): string {
	return JSON.stringify({
		ops: sourcePaths.map((sourcePath) => ({
			kind: "clear-suggested-canonical",
			sourcePath,
			reason: "test rollback",
		})),
	});
}

function arrayToDictOps(sourceArrayPath: string, keyField: string): string {
	return JSON.stringify({
		ops: [
			{
				kind: "reshape-array-to-dict",
				sourceArrayPath,
				keyField,
				toObjectPath: sourceArrayPath,
				omitKeyField: true,
				reason: "test dictionary reshape",
			},
		],
	});
}

function arrayFromObjectIntent(): string {
	return JSON.stringify({
		intents: [
			{
				id: "intent-1",
				kind: "array-from-object",
				sourceObjectPath: "footer.social",
				toArrayPath: "footer.social_links",
				memberPaths: ["footer.social.facebook", "footer.social.instagram"],
				reason: "same social-link schema",
			},
		],
	});
}

function acceptIntent(id = "intent-1"): string {
	return JSON.stringify({
		decisions: [
			{
				intentId: id,
				decision: "accept",
				reason: "array litmus passes",
			},
		],
	});
}

function setCanonicalIntent(
	sourcePath: string,
	toSuggestedCanonical: string,
): string {
	return JSON.stringify({
		intents: [
			{
				id: "intent-1",
				kind: "set-canonical",
				sourcePath,
				toSuggestedCanonical,
				reason: "test canonical rename",
			},
		],
	});
}

function objectToArrayOps(): string {
	return JSON.stringify({
		ops: [
			{
				kind: "reshape-object-to-array",
				sourceObjectPath: "footer.social",
				sourceMemberPaths: [
					"footer.social.facebook",
					"footer.social.instagram",
				],
				toArrayPath: "footer.social_links",
				reason: "test array reshape",
			},
		],
	});
}

const DOMAIN_OPS_PASS_VERDICT = JSON.stringify({
	verdict: "pass",
	findings: [],
});

function domainOpsResponse(_prompt: string, domainOpsJson: string): string {
	return domainOpsJson;
}

function agentResponse(output: string, inputTokens = 10) {
	return {
		output,
		turns: 1,
		inputTokens,
		outputTokens: inputTokens,
		cost: 0,
	};
}

describe("buildShapeNormalizePrompt", () => {
	it("asks for scoped ops and includes deterministic litmus tests", () => {
		const prompt = buildShapeNormalizePrompt(page);
		expect(prompt).toContain("Return only new ops needed for this pass");
		expect(prompt).toContain('"ops"');
		expect(prompt).toContain("Swap test");
		expect(prompt).toContain("Add/remove test");
		expect(prompt).toContain("Current materialized chrome");
		expect(prompt).not.toContain("content (JSON)");
	});

	it("does not make leaf-name cleanup a rejection reason for array passes", () => {
		const pass = SHAPE_NORMALIZE_PASSES.find(
			(candidate) => candidate.id === "arrays-from-objects",
		);
		if (!pass) throw new Error("missing arrays-from-objects pass");
		const chrome = { recent_posts: { posts: [{ image: "/post" }] } };
		const current: ClassifierOutput = {
			chromePaths: [
				{
					sourcePath: "recent_posts.posts[0].image",
					suggestedCanonical: "recent_posts.posts[*].image",
				},
			],
		};
		const reviewerPrompt = buildShapeNormalizeReviewerPrompt(
			{
				...page,
				chrome,
				chromePaths: [{ sourcePath: "recent_posts.posts[0].image" }],
			},
			{ ops: [] },
			current,
			materializeShapeNormalizedChrome(chrome, current.chromePaths),
			pass,
		);

		expect(reviewerPrompt).toContain(
			"Noisy leaves like `image`, `url`, `label`, or `alt_text`",
		);
		expect(reviewerPrompt).not.toContain(
			"image-like or link-like canonical keeps noisy leaf names",
		);
	});

	it("uses pass-specific reviewer completion checks", () => {
		const chrome = { footer: { links: { facebook: "/", instagram: "/" } } };
		const current: ClassifierOutput = {
			chromePaths: [
				{ sourcePath: "footer.links.facebook" },
				{ sourcePath: "footer.links.instagram" },
			],
		};
		const promptFor = (passId: string) => {
			const pass = SHAPE_NORMALIZE_PASSES.find(
				(candidate) => candidate.id === passId,
			);
			if (!pass) throw new Error(`missing ${passId} pass`);
			return buildShapeNormalizeReviewerPrompt(
				{
					...page,
					chrome,
					chromePaths: current.chromePaths,
				},
				{ ops: [] },
				current,
				materializeShapeNormalizedChrome(chrome, current.chromePaths),
				pass,
			);
		};

		const pass1Prompt = promptFor("arrays-from-objects");
		expect(pass1Prompt).toContain(
			"No remaining object-keyed or flat sibling family clearly passes, or ambiguously but plausibly passes, the array litmus test.",
		);
		expect(pass1Prompt).toContain(
			"Ambiguous collection-like object/keyed groups are converted to arrays",
		);
		expect(pass1Prompt).toContain(
			"ambiguous collection-like object/keyed groups",
		);
		expect(pass1Prompt).not.toContain(
			"No remaining `[*]` canonical fails the role/swap-harm/deletion-harm/schema-divergence tests.",
		);

		const pass2Prompt = promptFor("arrays-to-dicts");
		expect(pass2Prompt).toContain(
			"No remaining `[*]` canonical has concrete non-order structural evidence for dictionary shape.",
		);
		expect(pass2Prompt).toContain(
			"Scalar contract-role lists should become dictionaries with empty object members",
		);
		expect(pass2Prompt).toContain("Ambiguous arrays are accepted as arrays");
		expect(pass2Prompt).toContain(
			"scalar contract-role lists should become dictionaries",
		);
		expect(pass2Prompt).toContain("with empty object members");
		expect(pass2Prompt).not.toContain(
			"No remaining object-keyed or flat sibling family clearly passes every array litmus test.",
		);
	});
});

describe("validateShapeNormalizeOutput", () => {
	it("accepts the same sourcePath set with canonical adjustments", () => {
		const output: ClassifierOutput = {
			chromePaths: [
				{
					sourcePath: "header.logo.url",
					suggestedCanonical: "header.logo.src",
				},
				{ sourcePath: "header.logo.alt" },
				{
					sourcePath: "footer.contact_form.email_placeholder",
					suggestedCanonical: "footer.form_fields[*].placeholder",
				},
			],
		};
		expect(validateShapeNormalizeOutput(page, output)).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("rejects missing source paths", () => {
		const output: ClassifierOutput = {
			chromePaths: [{ sourcePath: "header.logo.url" }],
		};
		const result = validateShapeNormalizeOutput(page, output);
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("Missing sourcePath");
	});

	it("rejects unknown source paths", () => {
		const output: ClassifierOutput = {
			chromePaths: [{ sourcePath: "header.unknown" }],
		};
		const result = validateShapeNormalizeOutput(page, output);
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("Unknown sourcePath");
	});
});

describe("shape normalize ops", () => {
	it("parses fenced JSON responses", () => {
		expect(parseShapeNormalizeOpsOutput('```json\n{"ops":[]}\n```')).toEqual({
			ops: [],
		});
		expect(
			parseShapeNormalizeIntentOutput('```json\n{"intents":[]}\n```'),
		).toEqual({
			intents: [],
		});
	});

	it("parses, validates, and applies set/clear ops", () => {
		const current: ClassifierOutput = { chromePaths };
		const parsed = parseShapeNormalizeOpsOutput(
			setOps({
				sourcePath: "header.logo.url",
				to: "header.logo.src",
			}),
		);
		expect(parsed).toBeDefined();
		if (!parsed) throw new Error("expected parsed ops");
		expect(
			validateShapeNormalizeOps(page, current, parsed, {
				id: "leaf-names",
				name: "leaf",
				objective: "leaf",
				allowedChanges: [],
				litmusTests: [],
				rejectWhen: [],
				reviewerMustVerify: [],
			}),
		).toEqual({ valid: true, errors: [] });

		const applied = applyShapeNormalizeOps(current, parsed);
		expect(applied.chromePaths[0]).toEqual({
			sourcePath: "header.logo.url",
			suggestedCanonical: "header.logo.src",
		});

		const clear = parseShapeNormalizeOpsOutput(clearOps("header.logo.url"));
		if (!clear) throw new Error("expected clear ops");
		expect(applyShapeNormalizeOps(applied, clear).chromePaths[0]).toEqual({
			sourcePath: "header.logo.url",
		});
	});

	it("represents existing array containers with array-shaped canonicals before LLM decisions", () => {
		const current: ClassifierOutput = {
			chromePaths: [
				{ sourcePath: "header.navigation[0].label" },
				{ sourcePath: "header.navigation[0].href" },
				{
					sourcePath: "header.navigation[1].url",
					suggestedCanonical: "header.navigation[1].href",
				},
				{ sourcePath: "footer.logo.url" },
			],
		};

		expect(applyArrayRepresentationBaseline(current).chromePaths).toEqual([
			{
				sourcePath: "header.navigation[0].label",
				suggestedCanonical: "header.navigation[*].label",
			},
			{
				sourcePath: "header.navigation[0].href",
				suggestedCanonical: "header.navigation[*].href",
			},
			{
				sourcePath: "header.navigation[1].url",
				suggestedCanonical: "header.navigation[*].href",
			},
			{ sourcePath: "footer.logo.url" },
		]);
	});

	it("applies array-to-dictionary reshape using a child key field", () => {
		const formPage = {
			...page,
			chrome: {
				footer: {
					contact_form: {
						fields: [
							{
								name: "email",
								type: "email",
								placeholder: "Email",
								required: true,
							},
							{
								name: "message",
								type: "textarea",
								placeholder: "Message",
								required: true,
							},
						],
					},
				},
			},
			chromePaths: [
				{ sourcePath: "footer.contact_form.fields[0].name" },
				{ sourcePath: "footer.contact_form.fields[0].type" },
				{ sourcePath: "footer.contact_form.fields[0].placeholder" },
				{ sourcePath: "footer.contact_form.fields[0].required" },
				{ sourcePath: "footer.contact_form.fields[1].name" },
				{ sourcePath: "footer.contact_form.fields[1].type" },
				{ sourcePath: "footer.contact_form.fields[1].placeholder" },
				{ sourcePath: "footer.contact_form.fields[1].required" },
			],
		};
		const current: ClassifierOutput = { chromePaths: formPage.chromePaths };
		const parsed = parseShapeNormalizeOpsOutput(
			arrayToDictOps("footer.contact_form.fields", "name"),
		);
		if (!parsed) throw new Error("expected parsed ops");
		expect(
			validateShapeNormalizeOps(formPage, current, parsed, {
				id: "arrays-to-dicts",
				name: "dict",
				objective: "dict",
				allowedChanges: [],
				litmusTests: [],
				rejectWhen: [],
				reviewerMustVerify: [],
			}),
		).toEqual({ valid: true, errors: [] });

		const applied = applyShapeNormalizeOps(current, parsed, formPage.chrome);
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "footer.contact_form.fields[0].name",
			suggestedCanonical: "footer.contact_form.fields.email",
			materializeAs: "identity-key",
		});
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "footer.contact_form.fields[0].type",
			suggestedCanonical: "footer.contact_form.fields.email.type",
			materializeAs: "value",
		});
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "footer.contact_form.fields[1].placeholder",
			suggestedCanonical: "footer.contact_form.fields.message.placeholder",
			materializeAs: "value",
		});
	});

	it("rejects scalar array-to-dictionary pseudo key fields", () => {
		const pass = SHAPE_NORMALIZE_PASSES.find(
			(candidate) => candidate.id === "arrays-to-dicts",
		);
		if (!pass) throw new Error("missing arrays-to-dicts pass");
		const formPage = {
			...page,
			chrome: {
				footer: {
					form_fields: ["Name", "Email"],
				},
			},
			chromePaths: [
				{
					sourcePath: "footer.form_fields[0]",
					suggestedCanonical: "footer.form_fields[*]",
				},
				{
					sourcePath: "footer.form_fields[1]",
					suggestedCanonical: "footer.form_fields[*]",
				},
			],
		};
		const current: ClassifierOutput = { chromePaths: formPage.chromePaths };
		const parsedOps = parseShapeNormalizeOpsOutput(
			arrayToDictOps("footer.form_fields", "_value"),
		);
		if (!parsedOps) throw new Error("expected parsed ops");

		const opResult = validateShapeNormalizeOps(
			formPage,
			current,
			parsedOps,
			pass,
		);
		expect(opResult.valid).toBe(false);
		expect(opResult.errors.join("\n")).toContain(
			'requires an explicit child key field, not "_value"',
		);

		const parsedIntent = parseShapeNormalizeIntentOutput(
			JSON.stringify({
				intents: [
					{
						id: "intent-1",
						kind: "array-to-dict",
						sourceArrayPath: "footer.form_fields[*]",
						keyField: "_self",
						toObjectPath: "footer.form_fields",
						omitKeyField: false,
						reason: "scalar labels are roles",
					},
				],
			}),
		);
		if (!parsedIntent) throw new Error("expected parsed intent");

		const intentResult = validateShapeNormalizeIntents(parsedIntent, pass);
		expect(intentResult.valid).toBe(false);
		expect(intentResult.errors.join("\n")).toContain(
			'requires an explicit child key field, not "_self"',
		);
	});

	it("applies scalar array-to-dictionary reshape as empty object members", () => {
		const pass = SHAPE_NORMALIZE_PASSES.find(
			(candidate) => candidate.id === "arrays-to-dicts",
		);
		if (!pass) throw new Error("missing arrays-to-dicts pass");
		const scalarPage = {
			...page,
			chrome: { footer: { slots: ["primary", "secondary"] } },
			chromePaths: [
				{ sourcePath: "footer.slots[0]" },
				{ sourcePath: "footer.slots[1]" },
			],
		};
		const current = applyArrayRepresentationBaseline({
			chromePaths: scalarPage.chromePaths,
		});
		const parsed = parseShapeNormalizeOpsOutput(
			JSON.stringify({
				ops: [
					{
						kind: "reshape-scalar-array-to-dict",
						sourceArrayPath: "footer.slots",
						toObjectPath: "footer.slots",
						reason: "scalar values are contract roles",
					},
				],
			}),
		);
		if (!parsed) throw new Error("expected parsed ops");
		const validation = validateShapeNormalizeOps(
			scalarPage,
			current,
			parsed,
			pass,
		);
		expect(validation.valid).toBe(true);

		const applied = applyShapeNormalizeOps(current, parsed, scalarPage.chrome);
		expect(applied.chromePaths).toEqual([
			{
				sourcePath: "footer.slots[0]",
				suggestedCanonical: "footer.slots.primary",
				materializeAs: "empty-object",
			},
			{
				sourcePath: "footer.slots[1]",
				suggestedCanonical: "footer.slots.secondary",
				materializeAs: "empty-object",
			},
		]);
		expect(
			materializeShapeNormalizedChrome(scalarPage.chrome, applied.chromePaths)
				.chrome,
		).toEqual({ footer: { slots: { primary: {}, secondary: {} } } });
	});

	it("rejects array-to-dictionary ops with key-only object items", () => {
		const pass = SHAPE_NORMALIZE_PASSES.find(
			(candidate) => candidate.id === "arrays-to-dicts",
		);
		if (!pass) throw new Error("missing arrays-to-dicts pass");
		const keyedOnlyPage = {
			...page,
			chrome: {
				footer: {
					form_fields: [{ name: "email" }, { name: "phone" }],
				},
			},
			chromePaths: [
				{
					sourcePath: "footer.form_fields[0].name",
					suggestedCanonical: "footer.form_fields[*].name",
				},
				{
					sourcePath: "footer.form_fields[1].name",
					suggestedCanonical: "footer.form_fields[*].name",
				},
			],
		};
		const current: ClassifierOutput = {
			chromePaths: keyedOnlyPage.chromePaths,
		};
		const parsedOps = parseShapeNormalizeOpsOutput(
			JSON.stringify({
				ops: [
					{
						kind: "reshape-array-to-dict",
						sourceArrayPath: "footer.form_fields",
						keyField: "name",
						toObjectPath: "footer.form_fields",
						omitKeyField: true,
						reason: "roles differ",
					},
				],
			}),
		);
		if (!parsedOps) throw new Error("expected parsed ops");

		const result = validateShapeNormalizeOps(
			keyedOnlyPage,
			current,
			parsedOps,
			pass,
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("has no non-key payload");
	});

	it("clears stale identity-key materialization when a later set op takes ownership", () => {
		const current: ClassifierOutput = {
			chromePaths: [
				{
					sourcePath: "footer.fields[0].name",
					suggestedCanonical: "footer.fields.email",
					materializeAs: "identity-key",
				},
			],
		};
		const parsed = parseShapeNormalizeOpsOutput(
			setOps({
				sourcePath: "footer.fields[0].name",
				to: "footer.fields.email.title",
			}),
		);
		if (!parsed) throw new Error("expected parsed ops");

		expect(applyShapeNormalizeOps(current, parsed).chromePaths[0]).toEqual({
			sourcePath: "footer.fields[0].name",
			suggestedCanonical: "footer.fields.email.title",
		});
	});

	it("applies nested array-to-dictionary reshape under wildcard parent arrays", () => {
		const nestedPage = {
			...page,
			chrome: {
				sections: [
					{
						fields: [
							{ name: "email", type: "email" },
							{ name: "phone", type: "tel" },
						],
					},
					{
						fields: [
							{ name: "email", type: "email" },
							{ name: "message", type: "textarea" },
						],
					},
				],
			},
			chromePaths: [
				{ sourcePath: "sections[0].fields[0].name" },
				{ sourcePath: "sections[0].fields[0].type" },
				{ sourcePath: "sections[0].fields[1].name" },
				{ sourcePath: "sections[0].fields[1].type" },
				{ sourcePath: "sections[1].fields[0].name" },
				{ sourcePath: "sections[1].fields[0].type" },
				{ sourcePath: "sections[1].fields[1].name" },
				{ sourcePath: "sections[1].fields[1].type" },
			],
		};
		const current: ClassifierOutput = { chromePaths: nestedPage.chromePaths };
		const parsed = parseShapeNormalizeOpsOutput(
			arrayToDictOps("sections[*].fields", "name"),
		);
		if (!parsed) throw new Error("expected parsed ops");
		expect(
			validateShapeNormalizeOps(nestedPage, current, parsed, {
				id: "arrays-to-dicts",
				name: "dict",
				objective: "dict",
				allowedChanges: [],
				litmusTests: [],
				rejectWhen: [],
				reviewerMustVerify: [],
			}),
		).toEqual({ valid: true, errors: [] });

		const applied = applyShapeNormalizeOps(current, parsed, nestedPage.chrome);
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "sections[0].fields[0].name",
			suggestedCanonical: "sections[*].fields.email",
			materializeAs: "identity-key",
		});
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "sections[0].fields[1].type",
			suggestedCanonical: "sections[*].fields.phone.type",
			materializeAs: "value",
		});
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "sections[1].fields[1].type",
			suggestedCanonical: "sections[*].fields.message.type",
			materializeAs: "value",
		});
	});

	it("applies object-to-array reshape to member children", () => {
		const socialPage = {
			...page,
			chrome: {
				footer: {
					social: {
						facebook: { label: "Facebook", url: "/facebook" },
						instagram: { label: "Instagram", url: "/instagram" },
					},
				},
			},
			chromePaths: [
				{ sourcePath: "footer.social.facebook.label" },
				{ sourcePath: "footer.social.facebook.url" },
				{ sourcePath: "footer.social.instagram.label" },
				{ sourcePath: "footer.social.instagram.url" },
			],
		};
		const current: ClassifierOutput = { chromePaths: socialPage.chromePaths };
		const parsed = parseShapeNormalizeOpsOutput(objectToArrayOps());
		if (!parsed) throw new Error("expected parsed ops");
		expect(
			validateShapeNormalizeOps(socialPage, current, parsed, {
				id: "arrays-from-objects",
				name: "array",
				objective: "array",
				allowedChanges: [],
				litmusTests: [],
				rejectWhen: [],
				reviewerMustVerify: [],
			}),
		).toEqual({ valid: true, errors: [] });

		const applied = applyShapeNormalizeOps(current, parsed, socialPage.chrome);
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "footer.social.facebook.label",
			suggestedCanonical: "footer.social_links[*].label",
			materializeAs: "value",
		});
		expect(applied.chromePaths).toContainEqual({
			sourcePath: "footer.social.instagram.url",
			suggestedCanonical: "footer.social_links[*].url",
			materializeAs: "value",
		});
	});

	it("applies object-to-array reshape to scalar member leaves", () => {
		const socialPage = {
			...page,
			chrome: {
				footer: {
					social_media: {
						facebook: "/facebook",
						instagram: "/instagram",
					},
				},
			},
			chromePaths: [
				{ sourcePath: "footer.social_media.facebook" },
				{ sourcePath: "footer.social_media.instagram" },
			],
		};
		const current: ClassifierOutput = { chromePaths: socialPage.chromePaths };
		const parsed = parseShapeNormalizeOpsOutput(
			JSON.stringify({
				ops: [
					{
						kind: "reshape-object-to-array",
						sourceObjectPath: "footer.social_media",
						sourceMemberPaths: [
							"footer.social_media.facebook",
							"footer.social_media.instagram",
						],
						toArrayPath: "footer.social_media",
						reason: "same scalar social link schema",
					},
				],
			}),
		);
		if (!parsed) throw new Error("expected parsed ops");
		expect(
			validateShapeNormalizeOps(socialPage, current, parsed, {
				id: "arrays-from-objects",
				name: "array",
				objective: "array",
				allowedChanges: [],
				litmusTests: [],
				rejectWhen: [],
				reviewerMustVerify: [],
			}),
		).toEqual({ valid: true, errors: [] });

		const applied = applyShapeNormalizeOps(current, parsed, socialPage.chrome);
		expect(applied.chromePaths).toEqual([
			{
				sourcePath: "footer.social_media.facebook",
				suggestedCanonical: "footer.social_media[*]",
				materializeAs: "value",
			},
			{
				sourcePath: "footer.social_media.instagram",
				suggestedCanonical: "footer.social_media[*]",
				materializeAs: "value",
			},
		]);
	});
});

describe("deriveShapeNormalizeOps", () => {
	it("derives set-canonical ops from the final diff", () => {
		const before: ClassifierOutput = { chromePaths };
		const after: ClassifierOutput = {
			chromePaths: [
				{
					sourcePath: "header.logo.url",
					suggestedCanonical: "header.logo.src",
				},
				{ sourcePath: "header.logo.alt" },
				{
					sourcePath: "footer.contact_form.email_placeholder",
					suggestedCanonical: "footer.form_fields[*].placeholder",
				},
			],
		};
		expect(deriveShapeNormalizeOps(before, after)).toEqual([
			{
				kind: "set-suggested-canonical",
				sourcePath: "footer.contact_form.email_placeholder",
				toSuggestedCanonical: "footer.form_fields[*].placeholder",
				reason: "shape-normalize adjusted canonical path",
			},
			{
				kind: "set-suggested-canonical",
				sourcePath: "header.logo.url",
				toSuggestedCanonical: "header.logo.src",
				reason: "shape-normalize adjusted canonical path",
			},
		]);
	});
});

describe("shapeNormalizeOnePage", () => {
	it("splits structural conversion into intent and decision, then materializes with intent ops", async () => {
		const socialPage = {
			...page,
			chrome: {
				footer: {
					social: {
						facebook: { label: "Facebook", url: "/facebook" },
						instagram: { label: "Instagram", url: "/instagram" },
					},
				},
			},
			chromePaths: [
				{ sourcePath: "footer.social.facebook.label" },
				{ sourcePath: "footer.social.facebook.url" },
				{ sourcePath: "footer.social.instagram.label" },
				{ sourcePath: "footer.social.instagram.url" },
			],
		};
		let intentCalls = 0;
		const roles: string[] = [];
		const classifyResponse = (prompt: string) => {
			if (!prompt.includes("INTENT proposer")) return emptyOps;
			intentCalls++;
			return intentCalls === 1 ? arrayFromObjectIntent() : emptyIntents;
		};
		const reviewResponse = (prompt: string) =>
			prompt.includes("MAIN decision agent") ? acceptIntent() : "VERDICT: PASS";
		const runAgent: RunAgentFn = async ({ role, prompt }) => {
			roles.push(role);
			if (role === "classify") return agentResponse(classifyResponse(prompt));
			if (role === "review") return agentResponse(reviewResponse(prompt), 5);
			if (role === "review-a" || role === "review-b")
				return agentResponse(DOMAIN_OPS_PASS_VERDICT);
			if (role === "fix")
				return agentResponse(domainOpsResponse(prompt, objectToArrayOps()), 5);
			throw new Error(`unexpected role ${role}`);
		};

		const result = await shapeNormalizeOnePage({
			page: socialPage,
			runAgent,
			opsWorkdir: testOpsWorkdir("object-to-array"),
			maxRetries: 1,
		});

		expect(result.status).toBe("pass");
		expect(roles.slice(0, 2)).toEqual(["classify", "review"]);
		expect(roles).toContain("fix");
		expect(result.output?.chromePaths).toContainEqual({
			sourcePath: "footer.social.facebook.label",
			suggestedCanonical: "footer.social_links[*].label",
			materializeAs: "value",
		});
		expect(result.ops).toContainEqual({
			kind: "reshape-object-to-array",
			sourceObjectPath: "footer.social",
			sourceMemberPaths: ["footer.social.facebook", "footer.social.instagram"],
			toArrayPath: "footer.social_links",
			reason: "test array reshape",
		});
		expect(result.attempts[0]?.fix?.parsed?.ops?.[0]).toMatchObject({
			kind: "reshape-object-to-array",
		});
	});

	it("rejects accepted intents that cannot be materialized by intent ops", async () => {
		const socialPage = {
			...page,
			chrome: {
				footer: {
					social: {
						facebook: { label: "Facebook", url: "/facebook" },
						instagram: { label: "Instagram", url: "/instagram" },
					},
					other_social: {
						twitter: { label: "Twitter", url: "/twitter" },
						youtube: { label: "YouTube", url: "/youtube" },
					},
				},
			},
			chromePaths: [
				{ sourcePath: "footer.social.facebook.label" },
				{ sourcePath: "footer.social.facebook.url" },
				{ sourcePath: "footer.social.instagram.label" },
				{ sourcePath: "footer.social.instagram.url" },
				{ sourcePath: "footer.other_social.twitter.label" },
				{ sourcePath: "footer.other_social.twitter.url" },
				{ sourcePath: "footer.other_social.youtube.label" },
				{ sourcePath: "footer.other_social.youtube.url" },
			],
		};
		let intentCalls = 0;
		const invalidIntent = JSON.stringify({
			intents: [
				{
					id: "intent-1",
					kind: "array-from-object",
					sourceObjectPath: "footer.missing_social",
					toArrayPath: "footer.social_links",
					memberPaths: ["footer.missing_social.facebook"],
					reason: "invalid accepted intent",
				},
			],
		});
		const classifyResponse = (prompt: string) => {
			if (!prompt.includes("INTENT proposer")) return emptyOps;
			intentCalls++;
			return intentCalls === 1 ? invalidIntent : emptyIntents;
		};
		const reviewResponse = (prompt: string) =>
			prompt.includes("MAIN decision agent") ? acceptIntent() : "VERDICT: PASS";
		const runAgent: RunAgentFn = async ({ role, prompt }) => {
			if (role === "classify") return agentResponse(classifyResponse(prompt));
			if (role === "review") return agentResponse(reviewResponse(prompt), 5);
			if (role === "review-a" || role === "review-b")
				return agentResponse(DOMAIN_OPS_PASS_VERDICT);
			if (role === "fix") {
				return agentResponse(
					domainOpsResponse(
						prompt,
						JSON.stringify({
							ops: [
								{
									kind: "reshape-object-to-array",
									sourceObjectPath: "footer.missing_social",
									toArrayPath: "footer.social_links",
									sourceMemberPaths: ["footer.missing_social.facebook"],
									reason: "invalid accepted intent",
								},
							],
						}),
					),
					5,
				);
			}
			throw new Error(`unexpected role ${role}`);
		};

		const result = await shapeNormalizeOnePage({
			page: socialPage,
			runAgent,
			opsWorkdir: testOpsWorkdir("materialize-retry"),
			maxRetries: 1,
		});

		expect(result.status).toBe("pass");
		expect(result.ops).toEqual([]);
		expect(result.attempts[0]?.fix?.error).toContain(
			"has no sourcePath children",
		);
	});

	it("baselines existing arrays but still allows the array-to-dict pass to override false arrays", async () => {
		const formPage = {
			...page,
			chrome: {
				footer: {
					fields: [
						{ name: "email", type: "email" },
						{ name: "phone", type: "tel" },
					],
				},
			},
			chromePaths: [
				{ sourcePath: "footer.fields[0].name" },
				{ sourcePath: "footer.fields[0].type" },
				{ sourcePath: "footer.fields[1].name" },
				{ sourcePath: "footer.fields[1].type" },
			],
		};
		let intentCalls = 0;
		const classify = (prompt: string) => {
			if (!prompt.includes("INTENT proposer")) return emptyOps;
			intentCalls++;
			if (intentCalls === 1) return emptyIntents;
			if (intentCalls === 2) {
				return JSON.stringify({
					intents: [
						{
							id: "intent-1",
							kind: "array-to-dict",
							sourceArrayPath: "footer.fields[*]",
							keyField: "name",
							toObjectPath: "footer.fields",
							omitKeyField: true,
							reason: "field names are semantic roles",
						},
					],
				});
			}
			return emptyIntents;
		};
		const reviewOutput = (prompt: string) =>
			prompt.includes("MAIN decision agent") ? acceptIntent() : "VERDICT: PASS";
		const runAgent: RunAgentFn = async ({ role, prompt }) => {
			if (role === "classify") return agentResponse(classify(prompt));
			if (role === "review") return agentResponse(reviewOutput(prompt), 5);
			if (role === "review-a" || role === "review-b")
				return agentResponse(DOMAIN_OPS_PASS_VERDICT);
			if (role === "fix") {
				return agentResponse(
					domainOpsResponse(prompt, arrayToDictOps("footer.fields", "name")),
					5,
				);
			}
			throw new Error(`unexpected role ${role}`);
		};

		const result = await shapeNormalizeOnePage({
			page: formPage,
			runAgent,
			opsWorkdir: testOpsWorkdir("scalar-array"),
			maxRetries: 1,
		});

		expect(result.status).toBe("pass");
		expect(result.output?.chromePaths).toContainEqual({
			sourcePath: "footer.fields[0].name",
			suggestedCanonical: "footer.fields.email",
			materializeAs: "identity-key",
		});
		expect(result.output?.chromePaths).toContainEqual({
			sourcePath: "footer.fields[1].type",
			suggestedCanonical: "footer.fields.phone.type",
			materializeAs: "value",
		});
		expect(result.ops).toContainEqual({
			kind: "set-suggested-canonical",
			sourcePath: "footer.fields[0].type",
			fromSuggestedCanonical: undefined,
			toSuggestedCanonical: "footer.fields[*].type",
			reason: "shape-normalize adjusted canonical path",
		});
		expect(result.ops).toContainEqual({
			kind: "reshape-array-to-dict",
			sourceArrayPath: "footer.fields",
			keyField: "name",
			toObjectPath: "footer.fields",
			omitKeyField: true,
			reason: "test dictionary reshape",
		});
	});

	it("retries after invalid ops and returns derived final ops on pass", async () => {
		let classifyCalls = 0;
		let proposedRename = false;
		const runClassifyAgent = (attempt: number, prompt: string) => {
			classifyCalls++;
			if (classifyCalls === 1) {
				return {
					output: '{"chromePaths":[{"sourcePath":"header.logo.url"}]}',
					turns: 1,
					inputTokens: 10,
					outputTokens: 10,
					cost: 0,
				};
			}
			if (attempt < 3) return agentResponse(emptyIntents);
			if (!proposedRename && prompt.includes("id: structure-names")) {
				proposedRename = true;
				return agentResponse(
					setCanonicalIntent(
						"footer.contact_form.email_placeholder",
						"footer.form_fields[*].placeholder",
					),
				);
			}
			return agentResponse(emptyIntents);
		};
		const runFixAgent = (prompt: string) =>
			agentResponse(
				domainOpsResponse(
					prompt,
					setOps({
						sourcePath: "footer.contact_form.email_placeholder",
						to: "footer.form_fields[*].placeholder",
					}),
				),
				5,
			);
		const runAgent: RunAgentFn = async ({ role, attempt, prompt }) => {
			if (role === "classify") return runClassifyAgent(attempt, prompt);
			if (role === "review-a" || role === "review-b")
				return agentResponse(DOMAIN_OPS_PASS_VERDICT);
			if (role === "fix") return runFixAgent(prompt);
			return {
				output: prompt.includes("MAIN decision agent")
					? acceptIntent()
					: "VERDICT: PASS",
				turns: 1,
				inputTokens: 5,
				outputTokens: 5,
				cost: 0,
			};
		};

		const result = await shapeNormalizeOnePage({
			page,
			runAgent,
			opsWorkdir: testOpsWorkdir("invalid-suggest"),
			maxRetries: 2,
		});

		expect(result.status).toBe("pass");
		expect(result.ops).toHaveLength(1);
		expect(result.attempts.map((a) => a.passId)).toEqual([
			"arrays-from-objects",
			"arrays-from-objects",
			"arrays-to-dicts",
			"structure-names",
			"structure-names",
			"leaf-names",
		]);
	});

	it("uses reviewer rejection context in the next suggest round", async () => {
		let leafReviewCount = 0;
		let suggested = false;
		const classify = (prompt: string) => {
			const shouldSuggest =
				!suggested && prompt.includes("PREVIOUS ATTEMPT REJECTED");
			if (shouldSuggest) suggested = true;
			return shouldSuggest
				? setCanonicalIntent("header.logo.url", "header.logo.src")
				: emptyIntents;
		};
		const review = (prompt: string) => {
			if (prompt.includes("MAIN decision agent")) return acceptIntent();
			if (!prompt.includes("id: leaf-names")) return "VERDICT: PASS";
			leafReviewCount++;
			if (leafReviewCount === 1) {
				return "VERDICT: REJECT\nMissed obvious image normalization.\nREJECTION CONTEXT:\n- Set sourcePath `header.logo.url` to suggestedCanonical `header.logo.src`.";
			}
			return "VERDICT: PASS";
		};
		const runAgent: RunAgentFn = async ({ role, prompt }) => {
			if (role === "classify") {
				return agentResponse(classify(prompt));
			}
			if (role === "review") {
				return agentResponse(review(prompt), 5);
			}
			if (role === "review-a" || role === "review-b")
				return agentResponse(DOMAIN_OPS_PASS_VERDICT);
			if (role === "fix") {
				return agentResponse(
					domainOpsResponse(
						prompt,
						setOps({
							sourcePath: "header.logo.url",
							to: "header.logo.src",
						}),
					),
					5,
				);
			}
			throw new Error(`unexpected role ${role}`);
		};

		const result = await shapeNormalizeOnePage({
			page,
			runAgent,
			opsWorkdir: testOpsWorkdir("leaf-names"),
			maxRetries: 0,
		});

		expect(result.status).toBe("pass");
		expect(result.output?.chromePaths[0]).toEqual({
			sourcePath: "header.logo.url",
			suggestedCanonical: "header.logo.src",
		});
		const parsed = result.attempts.find((attempt) => {
			const value = attempt.normalize.parsed;
			return value && "intents" in value && value.intents.length > 0;
		})?.fix?.parsed;
		expect(parsed?.ops?.[0]).toMatchObject({
			kind: "set-suggested-canonical",
			sourcePath: "header.logo.url",
			toSuggestedCanonical: "header.logo.src",
		});
		expect(result.attempts.at(-1)?.review?.verdict).toBe("pass");
	});

	it("preserves reviewer obligations after invalid suggest output", async () => {
		const seenNormalizePrompts: string[] = [];
		let leafReviewCount = 0;
		let leafClassifyCount = 0;
		let suggested = false;
		const classify = (prompt: string) => {
			seenNormalizePrompts.push(prompt);
			leafClassifyCount++;
			if (leafClassifyCount === 2) return "not json";
			const shouldSuggest =
				!suggested && prompt.includes("PREVIOUS ATTEMPT REJECTED");
			if (shouldSuggest) suggested = true;
			return shouldSuggest
				? setCanonicalIntent("header.logo.url", "header.logo.src")
				: emptyIntents;
		};
		const review = (prompt: string) => {
			if (prompt.includes("MAIN decision agent")) return acceptIntent();
			if (!prompt.includes("id: leaf-names")) return "VERDICT: PASS";
			leafReviewCount++;
			if (leafReviewCount === 1) {
				return "VERDICT: REJECT\nMissed obvious image normalization.\nREJECTION CONTEXT:\n- Set sourcePath `header.logo.url` to suggestedCanonical `header.logo.src`.";
			}
			return "VERDICT: PASS";
		};

		const runAgent: RunAgentFn = async ({ role, prompt }) => {
			if (role === "classify") {
				return agentResponse(classify(prompt));
			}
			if (role === "review") {
				return agentResponse(review(prompt), 5);
			}
			if (role === "review-a" || role === "review-b")
				return agentResponse(DOMAIN_OPS_PASS_VERDICT);
			if (role === "fix") {
				return agentResponse(
					domainOpsResponse(
						prompt,
						setOps({
							sourcePath: "header.logo.url",
							to: "header.logo.src",
						}),
					),
					5,
				);
			}
			throw new Error(`unexpected role ${role}`);
		};

		const result = await shapeNormalizeOnePage({
			page,
			runAgent,
			opsWorkdir: testOpsWorkdir("reviewer-obligations"),
			maxRetries: 1,
		});

		expect(result.status).toBe("pass");
		expect(seenNormalizePrompts.length).toBeGreaterThanOrEqual(5);
		expect(
			seenNormalizePrompts.some((prompt) => prompt.includes("header.logo.src")),
		).toBe(true);
		expect(
			seenNormalizePrompts.some((prompt) =>
				prompt.includes("Previous intent output was not valid JSON"),
			),
		).toBe(true);
	});
});
