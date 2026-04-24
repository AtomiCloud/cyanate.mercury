/**
 * Pure logic for per-page chrome shape normalization.
 *
 * Runs immediately after chrome-classify and before any per-pagetype merge.
 * It does NOT add/remove chrome source paths; it only normalizes their
 * suggested canonical names so later harmonize phases see less representational
 * noise.
 */

import {
	type AgentCallRecord,
	type AgentCallTotals,
	type ClassifierOutput,
	type ClassifierPathEntry,
	type PageClassifyInput,
	parseChromeReviewerVerdict,
	type ReviewAttemptRecord,
	type RunAgentFn,
} from "./chrome-classify.js";
import {
	materializeShapeNormalizedChrome,
	type ShapeMaterializeResult,
} from "./chrome-shape-materialize.js";
import {
	type GenerateRunAgentFn,
	generateDomainOpsBatch,
} from "./domain-ops-generator.js";
import { collapseArrayIndices, readPath } from "./path-utils.js";

export interface PageShapeNormalizeInput extends PageClassifyInput {
	chrome: unknown;
	chromePaths: ClassifierPathEntry[];
}

export type ShapeNormalizeOp =
	| ShapeNormalizeCanonicalOp
	| ShapeNormalizeArrayToDictOp
	| ShapeNormalizeObjectToArrayOp
	| ShapeNormalizeScalarArrayToDictOp;

export interface ShapeNormalizeCanonicalOp {
	kind: "set-suggested-canonical" | "clear-suggested-canonical";
	sourcePath: string;
	fromSuggestedCanonical?: string;
	toSuggestedCanonical?: string;
	reason: string;
}

export interface ShapeNormalizeArrayToDictOp {
	kind: "reshape-array-to-dict";
	sourceArrayPath: string;
	keyField: string;
	toObjectPath: string;
	omitKeyField?: boolean;
	reason: string;
}

export interface ShapeNormalizeObjectToArrayOp {
	kind: "reshape-object-to-array";
	sourceObjectPath: string;
	sourceMemberPaths: string[];
	toArrayPath: string;
	reason: string;
}

export interface ShapeNormalizeScalarArrayToDictOp {
	kind: "reshape-scalar-array-to-dict";
	sourceArrayPath: string;
	toObjectPath: string;
	reason: string;
}

export type ShapeNormalizeIntent =
	| {
			id: string;
			kind: "array-from-object";
			sourceObjectPath: string;
			toArrayPath: string;
			memberPaths: string[];
			reason: string;
	  }
	| {
			id: string;
			kind: "array-to-dict";
			sourceArrayPath: string;
			keyField: string;
			toObjectPath: string;
			omitKeyField?: boolean;
			reason: string;
	  }
	| {
			id: string;
			kind: "scalar-array-to-dict";
			sourceArrayPath: string;
			toObjectPath: string;
			reason: string;
	  }
	| {
			id: string;
			kind: "set-canonical";
			sourcePath: string;
			toSuggestedCanonical: string;
			reason: string;
	  }
	| {
			id: string;
			kind: "clear-canonical";
			sourcePath: string;
			reason: string;
	  };

export interface ShapeNormalizeIntentOutput {
	intents: ShapeNormalizeIntent[];
}

export interface ShapeNormalizeIntentDecision {
	intentId: string;
	decision: "accept" | "reject";
	reason: string;
}

export interface ShapeNormalizeIntentDecisionOutput {
	decisions: ShapeNormalizeIntentDecision[];
}

export interface ShapeNormalizeValidationResult {
	valid: boolean;
	errors: string[];
}

export interface ShapeNormalizeOpsOutput {
	ops: ShapeNormalizeOp[];
}

export interface ShapeNormalizeAttemptRecord {
	attempt: number;
	passId?: ShapeNormalizePassId;
	passName?: string;
	normalize: AgentCallRecord & {
		parsed?: ShapeNormalizeOpsOutput | ShapeNormalizeIntentOutput;
		error?: string;
	};
	review?: ReviewAttemptRecord;
	fix?: AgentCallRecord & {
		parsed?: ShapeNormalizeOpsOutput;
		error?: string;
	};
	fixReview?: ReviewAttemptRecord;
}

export interface PageShapeNormalizeResult {
	status: "pass" | "fail";
	output?: ClassifierOutput;
	ops: ShapeNormalizeOp[];
	lastRejection?: string;
	attempts: ShapeNormalizeAttemptRecord[];
	totals: AgentCallTotals;
}

export interface ShapeNormalizeAttemptHooks {
	beforeNormalizeCall?: (
		attempt: number,
		prompt: string,
	) => Promise<void> | void;
	afterNormalizeCall?: (
		attempt: number,
		record: ShapeNormalizeAttemptRecord["normalize"],
	) => Promise<void> | void;
	beforeReviewCall?: (attempt: number, prompt: string) => Promise<void> | void;
	afterReviewCall?: (
		attempt: number,
		record: ReviewAttemptRecord,
	) => Promise<void> | void;
	beforeFixCall?: (attempt: number, prompt: string) => Promise<void> | void;
	afterFixCall?: (
		attempt: number,
		record: NonNullable<ShapeNormalizeAttemptRecord["fix"]>,
	) => Promise<void> | void;
	beforeFixReviewCall?: (
		attempt: number,
		prompt: string,
	) => Promise<void> | void;
	afterFixReviewCall?: (
		attempt: number,
		record: ReviewAttemptRecord,
	) => Promise<void> | void;
}

export interface ShapeNormalizeOnePageOptions {
	page: PageShapeNormalizeInput;
	runAgent: RunAgentFn;
	opsWorkdir: string;
	maxRetries: number;
	hooks?: ShapeNormalizeAttemptHooks;
	passIds?: readonly ShapeNormalizePassId[] | null;
}

export type ShapeNormalizePassId =
	| "arrays-from-objects"
	| "arrays-to-dicts"
	| "structure-names"
	| "leaf-names";

export interface ShapeNormalizePass {
	id: ShapeNormalizePassId;
	name: string;
	objective: string;
	allowedChanges: string[];
	litmusTests: string[];
	rejectWhen: string[];
	reviewerMustVerify: string[];
}

export const SHAPE_NORMALIZE_PASSES: readonly ShapeNormalizePass[] = [
	{
		id: "arrays-from-objects",
		name: "Pass 1 - Convert true collections to arrays",
		objective:
			"Find object or flat sibling shapes that should canonically be repeatable arrays.",
		allowedChanges: [
			"Convert repeated same-kind siblings into `[*]` paths only when every listed litmus test passes.",
			"Preserve existing good canonicals that are unrelated to array conversion.",
			"Leave named processing-contract roles as dictionaries/objects; convert additive peer items to arrays.",
			"On ambiguity, prefer array-shaped canonicals for collection-like siblings because arrays are the more flexible shape.",
		],
		litmusTests: [
			"Swap test: if two members swap positions, the meaning is unchanged except order.",
			"Add/remove test: adding or removing one member is a local content operation and does not require changing validation, submission, routing, branching, or schema logic.",
			"Same-shape test: each member has the same leaf schema, allowing optional missing leaves only when the role is still the same.",
			"Identity test: a member is identified by item order or a stable item-identity field, not by an object key that names a processing-contract role.",
			"Consumer test: a renderer would naturally use `for item in items` for this group.",
			"Processing-contract test: if adding a member requires new validation, backend payload handling, route handling, layout slot logic, or cross-field coordination, keep object/dictionary shape.",
			"Ambiguity test: if a sibling group is plausibly repeatable and the only objection is guessed role semantics, prefer array.",
		],
		rejectWhen: [
			"Clear named processing-contract roles are collapsed into `[*]` only because they look similar.",
			"Swapping members would alter meaning beyond display order.",
			"The candidate creates an array whose items would have different schemas or different semantic jobs.",
			"The candidate discards object-key identity that is the only payload distinguishing scalar values.",
		],
		reviewerMustVerify: [
			"No remaining object-keyed or flat sibling family clearly passes, or ambiguously but plausibly passes, the array litmus test.",
			"Every existing or proposed `[*]` canonical is a true repeatable collection.",
			"Clear named one-off roles remain object/dictionary-shaped even if their leaves look similar.",
			"Ambiguous collection-like object/keyed groups are converted to arrays; reviewer rejections must not preserve dictionary shape based on guessed role semantics alone.",
			"Reviewer rejections name the exact source members that should become one `[*]` collection.",
		],
	},
	{
		id: "arrays-to-dicts",
		name: "Pass 2 - Revert false arrays to dictionaries",
		objective:
			"Undo array-shaped canonicals when the members are actually named roles or positional slots with distinct meaning.",
		allowedChanges: [
			"Remove `[*]` from canonicals that fail swap/add/remove/same-shape tests.",
			"Convert arrays to dictionaries only when each item is an object whose explicit child key field names a processing-contract role and has non-key payload.",
			"Prefer concise dictionary/object paths for processing-contract role groups.",
			"Preserve true arrays accepted by Pass 1.",
			"On ambiguity, keep the existing array-shaped canonical.",
			"Explicit key fields alone are not enough evidence for dictionary shape; decide whether the key is item identity or a processing-contract role.",
			"Distinct scalar labels alone are not enough evidence for dictionary shape, except when those labels name contract roles.",
			"Item-identity collections stay arrays by default.",
		],
		litmusTests: [
			"Explicit-key test: convert only when items expose a real child key field; never use the scalar value itself as the key.",
			"Key-context test: classify the key as `item_identity` or `contract_role`; convert only for `contract_role` keys.",
			"Payload test: the array item must have non-key payload fields that will live under the dictionary key.",
			"Role test: keep a dictionary only when item objects encode processing-contract roles, not merely peer item identities.",
			"Swap harm test: keep a dictionary only when swapping entries breaks validation, submission, routing, branching, layout-slot, or schema meaning beyond display/render order.",
			"Deletion harm test: keep a dictionary only when removing one entry requires special-case handling in the remaining processing contract, not merely omits one rendered item.",
			"Schema divergence test: keep a dictionary when item leaves differ because the roles differ.",
			"Ambiguity test: if the evidence is only semantic guessing, preserve the array.",
			"Scalar-label context test: arrays of plain strings/numbers stay arrays for item-identity lists, but scalar contract-role lists should become dictionaries with empty member payloads.",
		],
		rejectWhen: [
			"A heterogeneous object remains array-shaped.",
			"A true homogeneous list is reverted to numbered dictionary keys.",
			"A scalar list of strings/numbers is converted to a self-keyed or value-keyed dictionary.",
			"A conversion would duplicate the same scalar as both object key and value, or omit the scalar leaving no payload.",
			"The argument for dictionary shape depends on inferred semantics that are not present as fields in the data.",
			"The key field is item identity for an additive peer collection.",
			"An item-identity scalar list is converted to dictionary shape because values look role-like.",
			"The pass changes non-array naming concerns that belong to later passes.",
		],
		reviewerMustVerify: [
			"No remaining `[*]` canonical has concrete non-order structural evidence for dictionary shape.",
			"Every true homogeneous collection accepted by Pass 1 remains array-shaped.",
			"Item-identity scalar arrays remain array-shaped unless context proves processing-contract roles.",
			"Scalar contract-role lists should become dictionaries with empty object members.",
			"False arrays are converted to dictionaries using a stable explicit child key only when that key names a processing-contract role.",
			"Ambiguous arrays are accepted as arrays; reviewer rejections must not be based on guessed semantics alone.",
			"For any rejection, the reviewer can point to the explicit child key field, at least one non-key payload field that survives under each dictionary member, and the processing contract that key belongs to.",
			"Reviewer rejections name the exact array path and why it should be dictionary-shaped.",
		],
	},
	{
		id: "structure-names",
		name: "Pass 3 - Normalize structural/container names",
		objective:
			"Make container names concise, canonical, and snake_case without changing shape.",
		allowedChanges: [
			"Use snake_case for every suggested canonical segment.",
			"Prefer `header`, `footer`, `nav`, `contact`, `cta`, `logo`, `social`, `form`, `team`, `services`, `testimonials`, `faq` when those are the canonical concept.",
			"Strip extra wording: `contact_information` and `contact_info` become `contact`; `navigation` becomes `nav`; verbose wrapper words are removed when they add no meaning.",
			"Keep page-specific meaningful nouns when shortening would lose meaning.",
		],
		litmusTests: [
			"Concision test: removing a word does not lose useful CMS/rendering meaning.",
			"Canonical vocabulary test: the shorter name is a standard site-structure term.",
			"Snake-case test: segments contain lowercase words separated by underscores.",
			"Scope test: site shell stays under `header`/`footer`; do not move body-like concepts into shell containers.",
		],
		rejectWhen: [
			"Semantic information is stripped rather than redundant wrapper wording.",
			"Distinct concepts are fused because their names became too generic.",
			"Leaf convention changes are made here instead of in the leaf-name pass.",
		],
		reviewerMustVerify: [
			"No remaining container segment is verbose, non-snake-case, or outside canonical site-structure vocabulary.",
			"Every structural rename preserves the existing array-vs-dict topology exactly.",
			"Leaf names are ignored unless they are part of a container segment rename.",
			"Reviewer rejections name the exact container prefix or source paths requiring structural rename.",
		],
	},
	{
		id: "leaf-names",
		name: "Pass 4 - Normalize leaf names",
		objective:
			"Normalize terminal leaf names to stable conventions for links, media, titles, and descriptions.",
		allowedChanges: [
			"Use `.href` for link destinations.",
			"Use `.src` for image/file/media sources.",
			"Use `.alt` for image alt text.",
			"Use `.title` for visible link/card/item titles or labels when the value names the item.",
			"Use `.desc` for descriptions; prefer `desc` over `description` in canonicals.",
			"Do not invent sibling leaves that are absent from the source paths.",
		],
		litmusTests: [
			"Value-role test: choose the leaf name by what the value is, not by a noisy source key.",
			"Destination test: URLs that navigate should end in `.href`; media URLs should end in `.src`.",
			"Display-text test: link/card names use `.title` when they name the destination/item.",
			"Description test: explanatory body copy in chrome metadata uses `.desc`.",
			"No-invention test: normalizing `image.url` to `image.src` does not imply an `image.alt` path exists.",
		],
		rejectWhen: [
			"A scalar social/contact URL becomes an invented nested object unless that is the selected canonical shape.",
			"A non-link media source is renamed to `.href`, or a link destination is renamed to `.src`.",
			"Verbose leaf names like `.description`, `.url`, `.link`, `.image` remain when `.desc`, `.href`, or `.src` is clearly correct.",
		],
		reviewerMustVerify: [
			"No remaining terminal leaf keeps a noisy convention when `.href`, `.src`, `.alt`, `.title`, or `.desc` is clearly correct.",
			"Leaf renames do not change container shape, array-vs-dict topology, or invent missing sibling leaves.",
			"Link destinations use `.href`; media/file sources use `.src`; image alt text uses `.alt`.",
			"Reviewer rejections name the exact leaf source paths and exact replacement leaf names.",
		],
	},
];

const JSON_ONLY_PREAMBLE = `You are a JSON-only shape normalizer. Your ENTIRE response MUST be a single JSON
object parseable by \`JSON.parse\`. No prose before or after. No markdown code
fences. No explanation. The very first character of your response is \`{\` and
the very last character is \`}\`.`;

const CANONICAL_NAME_RE = /^[A-Za-z0-9._[\]*-]+$/;
const INVALID_ARRAY_TO_DICT_KEY_FIELDS = new Set(["_self", "_value"]);

const SHAPE_CONTEXT_POLICY = `## Shape context policy

Arrays represent additive peer collections.
Objects/dictionaries represent named roles in a processing contract.

A group should be array-shaped when adding/removing/reordering one member is a
local content operation:
- a renderer can loop the items
- all items share one consumer path
- adding a new item does not require new validation, submission handling,
  routing, business logic, layout-slot handling, or schema changes
- item identity can live as data on the item

A group should be object/dictionary-shaped when keys name contract roles:
- consumers address members by role, not by iteration
- adding a member means changing a processing or schema contract
- members participate in validation, submission, routing, branching, or layout
  slots
- order is secondary to role identity

Key-field rule:
- An explicit key field is not sufficient evidence for dictionary shape.
- First classify the key as item_identity or contract_role.
- item_identity keys stay arrays; contract_role keys may become objects.
- Scalar contract-role lists should normalize to dictionaries with empty object
  members because the scalar values name contract slots, not additive peer
  content.`;

export function buildShapeNormalizePrompt(
	input: PageShapeNormalizeInput,
	pass: ShapeNormalizePass = SHAPE_NORMALIZE_PASSES[0],
	current: ClassifierOutput = { chromePaths: input.chromePaths },
	rejectionContext?: string,
): string {
	const materialized = materializeShapeNormalizedChrome(
		input.chrome,
		current.chromePaths,
	);
	const body = `${JSON_ONLY_PREAMBLE}

You are normalizing the SHAPE of accepted chrome fields for ONE page.

Your job is NOT to decide what is chrome. That has already been decided.
Your job is ONLY to propose ops that normalize awkward per-page path shape
into cleaner canonical paths via \`suggestedCanonical\`.

You see the CURRENT MATERIALIZED chrome after all accepted ops so far have
already been applied in memory. Do not reason from old noisy paths. Propose
MORE path rewrite ops from this clean current shape.

You MUST NOT rewrite the full table. Return only new ops needed for this pass.
Every op must reference an existing original \`sourcePath\` from the source-path
reference. Do NOT invent, add, remove, or change sourcePath strings. Use an
empty ops array when this pass has no more changes to suggest.

## Current pass

- id: ${pass.id}
- name: ${pass.name}
- objective: ${pass.objective}

${SHAPE_CONTEXT_POLICY}

This is one pass in a multi-pass pipeline. Only make changes allowed by this
pass. Preserve already-good \`suggestedCanonical\` values from earlier passes
unless this pass is explicitly responsible for correcting them.

Allowed changes in this pass:
${pass.allowedChanges.map((line) => `- ${line}`).join("\n")}

Deterministic litmus tests for this pass:
${pass.litmusTests.map((line) => `- ${line}`).join("\n")}

Reject your own change when:
${pass.rejectWhen.map((line) => `- ${line}`).join("\n")}

## Current materialized chrome

- page_type: ${input.pagetype}
- url: ${input.url}
- current_materialized_chrome (JSON):

\`\`\`json
${JSON.stringify(materialized.chrome, null, 2)}
\`\`\`

## Source path reference

\`\`\`json
${JSON.stringify({ provenance: materialized.provenance }, null, 2)}
\`\`\`

## Global shape-normalization rules

Only normalize shape when this semantic litmus test passes cleanly:

1. Iteration test:
   Could a consumer naturally render this by looping items of one kind?
2. Swap test:
   If two members were swapped, would the structure still mean the same thing
   in a different order?
3. Insert/delete test:
   Could one member be added or removed while preserving the same collection?
4. Schema test:
   Do members share one per-item schema?
5. Identity test:
   Could members be identified by a stable field or synthetic slot name?
6. Processing-contract test:
   Is this an additive peer item collection, or does each key name a role in a
   validation/submission/routing/layout/schema contract?

If those tests do NOT pass cleanly, follow the pass-specific tie-breaker below.

Object-to-array tie-breaker:
- Bias object/dictionary -> array for ambiguous collection-like siblings. Arrays
  are the more flexible canonical shape.
- Keep object/dictionary only when the keys clearly encode one-off roles or are
  the only payload distinguishing scalar values.
- Reordering that would change which named role a value belongs to is swap harm.
- If the case is ambiguous but plausibly repeatable, convert to array. Do not
  reject an array conversion just because dictionary shape is plausible.

Array-to-dictionary tie-breaker:
- Convert array -> dictionary only with concrete structural evidence in the
  data: object items, an explicit child key field that names a contract role,
  and non-key payload under each item.
- Do not convert additive peer collections just because they have an explicit
  identity field such as platform, label, title, href, slug, or id.
- Keep scalar arrays as arrays by default for item-identity lists.
- Scalar contract-role lists are the exception: role names should become a
  dictionary with empty object members.
- Reordering that only changes display order is not swap harm.
- If the case is ambiguous, keep the existing array. Do not reject a no-op
  result just because dictionary shape is plausible.
- If the only evidence is scalar values that happen to read like roles, keep
  the array unless context proves those values name processing-contract slots.

Normalize only representational shape issues such as:
- singleton wrapper array -> singular canonical path
- singular wrapper -> child field canonical path (for example \`logo\` vs \`logo.src\`)
- flat named sibling family -> repeated array-shaped canonical path
- split textual parts -> single scalar canonical path

## Canonical leaf conventions

When normalizing shape, prefer these canonical leaf names:

- Image/file source leaves should end in \`.src\`.
  Examples:
  - \`logo\` -> \`logo.src\`
  - \`image\` -> \`image.src\`
  - \`hero_image\` -> \`hero_image.src\`
- Image alt-text leaves should end in \`.alt\`.
- Link destination leaves should end in \`.href\`.
  Examples:
  - \`cta.link\` -> \`cta.href\`
  - \`facebook_url\` -> \`facebook.href\`
  - \`button.url\` -> \`button.href\`

These are shape conventions only. Do NOT invent missing siblings just because
one canonical leaf exists. For example, normalize an image path to \`.src\`
without inventing an \`.alt\` entry when no alt sourcePath exists on the page.

Do NOT:
- add or remove source paths
- invent synthetic source paths
- rewrite semantic meaning
- collapse distinct named roles into an array unless the litmus clearly passes

Do not suggest an op for a path that is already correct in the current
materialized chrome. Suggest only additional rewrites that improve the current
materialized shape for this pass.

## Output

Return ONLY this JSON shape:

{
  "ops": [
    {
      "kind": "set-suggested-canonical",
      "sourcePath": "<existing sourcePath>",
      "toSuggestedCanonical": "<canonical path>",
      "reason": "<short reason grounded in this pass's litmus tests>"
    },
    {
      "kind": "clear-suggested-canonical",
      "sourcePath": "<existing sourcePath>",
      "reason": "<short reason grounded in this pass's litmus tests>"
    },
    {
      "kind": "reshape-array-to-dict",
      "sourceArrayPath": "<existing array path>",
      "keyField": "<child field containing the dictionary key>",
      "toObjectPath": "<target object path>",
      "omitKeyField": true,
      "reason": "<short reason grounded in this pass's role/schema tests>"
    }
  ]
}

Rules:
- Return only ops for source paths that change in this pass.
- Use \`set-suggested-canonical\` to set or replace a canonical.
- Use \`clear-suggested-canonical\` only when this pass is explicitly reverting
  a bad prior canonical.
- Use \`reshape-array-to-dict\` only when this pass is reverting a false array
  whose explicit child field is a contract-role key. This consumes that key
  field as object identity instead of a leaf.
- Do not use \`reshape-array-to-dict\` for scalar arrays. Do not use pseudo
  key fields like \`_self\` or \`_value\`.
- \`toSuggestedCanonical\` must be a single path string when kind is
  \`set-suggested-canonical\`.
- Use \`[*]\` wildcards in \`toSuggestedCanonical\` only when representing
  repeatable collections.

Begin.`;

	if (rejectionContext) {
		return `${body}\n\n---\nPREVIOUS ATTEMPT REJECTED. Fix these issues:\n${rejectionContext}`;
	}
	return body;
}

export function buildShapeIntentPrompt(
	input: PageShapeNormalizeInput,
	pass: ShapeNormalizePass,
	current: ClassifierOutput,
	rejectionContext?: string,
): string {
	const materialized = materializeShapeNormalizedChrome(
		input.chrome,
		current.chromePaths,
	);
	const body = `${JSON_ONLY_PREAMBLE}

You are the INTENT proposer for one chrome shape-normalization pass.

Your job is only to identify shape-normalization intents. Do NOT write
executable ops.
Respect the current pass boundary:
- arrays-from-objects and arrays-to-dicts are topology passes; do NOT rename
  leaves or normalize labels like url/href/src/title in those passes.
- structure-names and leaf-names are canonical-name passes; emit only
  set-canonical or clear-canonical intents in those passes.

## Current pass

- id: ${pass.id}
- name: ${pass.name}
- objective: ${pass.objective}

${SHAPE_CONTEXT_POLICY}

Allowed changes in this pass:
${pass.allowedChanges.map((line) => `- ${line}`).join("\n")}

Deterministic litmus tests for this pass:
${pass.litmusTests.map((line) => `- ${line}`).join("\n")}

Reject your own suggestion when:
${pass.rejectWhen.map((line) => `- ${line}`).join("\n")}

## Current materialized chrome

- page_type: ${input.pagetype}
- url: ${input.url}

\`\`\`json
${JSON.stringify(materialized.chrome, null, 2)}
\`\`\`

## Source path reference

\`\`\`json
${JSON.stringify({ provenance: materialized.provenance }, null, 2)}
\`\`\`

## Output

Return ONLY this JSON shape:

{
  "intents": [
    {
      "id": "intent-1",
      "kind": "array-from-object",
      "sourceObjectPath": "<object whose children are same-kind members>",
      "toArrayPath": "<target array path>",
      "memberPaths": ["<member object path>", "<member object path>"],
      "reason": "<why the array litmus tests pass>"
    },
    {
      "id": "intent-2",
      "kind": "array-to-dict",
      "sourceArrayPath": "<array path>",
      "keyField": "<explicit child field whose value is the dictionary key>",
      "toObjectPath": "<target object path>",
      "omitKeyField": true,
      "reason": "<why role/schema/swap tests fail for array semantics>"
    },
    {
      "id": "intent-3",
      "kind": "scalar-array-to-dict",
      "sourceArrayPath": "<scalar array path>",
      "toObjectPath": "<target object path>",
      "reason": "<why scalar values are contract roles with empty payloads>"
    },
    {
      "id": "intent-4",
      "kind": "set-canonical",
      "sourcePath": "<source path>",
      "toSuggestedCanonical": "<new canonical path>",
      "reason": "<why this canonical name is better>"
    },
    {
      "id": "intent-5",
      "kind": "clear-canonical",
      "sourcePath": "<source path>",
      "reason": "<why the current suggested canonical should be cleared>"
    }
  ]
}

Rules:
- For pass arrays-from-objects, emit only "array-from-object" intents.
- For pass arrays-to-dicts, emit only "array-to-dict" or
  "scalar-array-to-dict" intents.
- For pass structure-names and leaf-names, emit only "set-canonical" or
  "clear-canonical" intents.
- If there is no clear allowed change for this pass, return {"intents":[]}.
- This is not execution. Do not include executable ops.
- For arrays-from-objects, emit an intent when object members clearly pass the
  collection tests, or when the group is ambiguous but plausibly repeatable.
  Keep object/dictionary only for clear one-off roles.
- For arrays-to-dicts, emit an intent when array items are objects with an
  explicit child key field that names a contract role, plus non-key payload.
- For scalar contract-role lists, use "scalar-array-to-dict"; the materializer
  will create dictionary keys with empty object members.
- Never use scalar values as keys for item-identity lists; never use pseudo
  fields like _self or _value for the existing object-item op.
- Ambiguous cases stay as arrays. Do not emit an intent just because a scalar
  label could be interpreted as a role.
- Arrays of scalar contract-role names are role lists, not peer content lists.
- For topology intents, every reason must explicitly state whether the key or
  member identity is item_identity or contract_role, and must include an
  add-member test and a consumer test.
- For canonical rename intents, each intent should describe exactly one
  sourcePath canonical change and cite the naming/value-role evidence. The
  materializer will produce the domain op.

Begin.`;

	if (rejectionContext) {
		return `${body}\n\n---\nPREVIOUS ATTEMPT REJECTED. Fix these issues:\n${rejectionContext}`;
	}
	return body;
}

export function buildShapeIntentDecisionPrompt(
	input: PageShapeNormalizeInput,
	pass: ShapeNormalizePass,
	current: ClassifierOutput,
	intents: ShapeNormalizeIntentOutput,
): string {
	const materialized = materializeShapeNormalizedChrome(
		input.chrome,
		current.chromePaths,
	);
	return `${JSON_ONLY_PREAMBLE}

You are the MAIN decision agent for one chrome shape-normalization pass.

A separate proposer emitted shape-normalization intents. Your job is only to
accept or reject each intent. Do NOT write executable ops.

## Current pass

- id: ${pass.id}
- name: ${pass.name}
- objective: ${pass.objective}

${SHAPE_CONTEXT_POLICY}

Litmus tests:
${pass.litmusTests.map((line) => `- ${line}`).join("\n")}

Reject when:
${pass.rejectWhen.map((line) => `- ${line}`).join("\n")}

## Current materialized chrome

\`\`\`json
${JSON.stringify(materialized.chrome, null, 2)}
\`\`\`

## Proposed intents

\`\`\`json
${JSON.stringify(intents, null, 2)}
\`\`\`

## Output

Return ONLY:

{
  "decisions": [
    {
      "intentId": "<id from proposed intents>",
      "decision": "accept",
      "reason": "<short reason>"
    },
    {
      "intentId": "<id from proposed intents>",
      "decision": "reject",
      "reason": "<short reason>"
    }
  ]
}

Rules:
- Emit exactly one decision for every proposed intent.
- Accept only if the pass litmus tests clearly pass.
- Reject if the intent belongs to another pass.
- For topology passes, reject naming work or semantic aliasing.
- For structure-names and leaf-names, reject topology work and evaluate only
  set-canonical/clear-canonical naming intents.
- For topology intents, reject if the reason does not classify the relevant
  key/member identity as item_identity or contract_role.
- For topology intents, reject if the reason does not explain whether adding a
  member is a local content append or a processing-contract change.
- For arrays-from-objects, accept ambiguous collection-like groups as arrays.
  Reject only when the group is clearly made of one-off named roles.
- For arrays-to-dicts, accept scalar-array-to-dict only when scalar values are
  contract roles with empty payloads. For object-item array-to-dict, reject
  pseudo key fields like _self/_value, duplicate key/value conversions, or
  conversions that leave no non-key payload.
- For arrays-to-dicts, reject intents whose key field is item_identity, such as
  peer item identity in an additive collection.
- For ambiguous array-vs-dict cases, prefer array topology and accept the no-op.
- For object-item array-to-dict, reject any intent that cites only scalar labels
  as role evidence without an explicit child key field plus non-key payload.

Begin.`;
}

export function buildShapeNormalizeReviewerPrompt(
	input: PageShapeNormalizeInput,
	passOps: ShapeNormalizeOpsOutput,
	finalOutput: ClassifierOutput,
	materialized: ShapeMaterializeResult,
	pass: ShapeNormalizePass = SHAPE_NORMALIZE_PASSES[0],
): string {
	return `You are reviewing the final result for one per-page chrome shape-normalization pass.

This is NOT chrome-vs-body review. The chrome source paths were already accepted.
Review only whether this pass has no remaining obvious work and whether the
accepted ops for this pass are sound.

## Current pass

- id: ${pass.id}
- name: ${pass.name}
- objective: ${pass.objective}

${SHAPE_CONTEXT_POLICY}

Review only this pass's responsibilities. Do not reject for work intentionally
reserved for later passes.

Allowed changes in this pass:
${pass.allowedChanges.map((line) => `- ${line}`).join("\n")}

Deterministic litmus tests for this pass:
${pass.litmusTests.map((line) => `- ${line}`).join("\n")}

Reject when:
${pass.rejectWhen.map((line) => `- ${line}`).join("\n")}

Pass-specific completion checks:
${pass.reviewerMustVerify.map((line) => `- ${line}`).join("\n")}

## Final materialized chrome for this pass

- page_type: ${input.pagetype}
- url: ${input.url}
- final_materialized_chrome (JSON):

\`\`\`json
${JSON.stringify(materialized.chrome, null, 2)}
\`\`\`

## Source path reference

\`\`\`json
${JSON.stringify({ provenance: materialized.provenance }, null, 2)}
\`\`\`

## Ops accepted during this pass

\`\`\`json
${JSON.stringify(passOps, null, 2)}
\`\`\`

## Final normalized path table

\`\`\`json
${JSON.stringify(finalOutput, null, 2)}
\`\`\`

## Review criteria

PASS when:
- every original sourcePath is preserved exactly once
- no source paths were added or removed
- the accepted ops are scoped to this pass
- every pass-specific completion check above is satisfied
- changes are within this pass's allowed scope
- suggested canonical paths are only shape cleanups, not semantic rewrites
- array-like canonicals only appear when the collection litmus clearly holds
- ambiguous collection-like object/keyed groups become arrays
- ambiguous item-identity scalar arrays remain arrays

REJECT when:
- any sourcePath is missing / added / changed
- an op is unnecessary or belongs to a different pass
- a pass-specific completion check still has an obvious failing candidate
- a suggestedCanonical invents a dubious array
- a suggestedCanonical fuses distinct named roles
- a suggestedCanonical is clearly worse or less faithful than the input shape
- there is any additional obvious shape normalization in this pass's scope still left undone
- in arrays-from-objects, an ambiguous collection-like object/keyed group stayed
  dictionary-shaped only because dictionary shape was plausible
- in arrays-to-dicts, a scalar array was converted to a self-keyed/value-keyed
  dictionary or a dictionary with no non-key payload

Important scope guard:
- Do not reject for container-name cleanup, leaf-name cleanup, or other work
  reserved for a different pass.
- In \`arrays-from-objects\` and \`arrays-to-dicts\`, review only array-vs-dict
  topology. Noisy leaves like \`image\`, \`url\`, \`label\`, or \`alt_text\`
  are not rejection reasons in those passes.
- In \`arrays-from-objects\`, ambiguous collection-like object/keyed groups
  should become arrays. Do not preserve dictionary shape only because named-role
  semantics are plausible.
- In \`arrays-to-dicts\`, do not reject a no-op for scalar arrays of labels,
  URLs, or other values when they are item-identity lists.
- In \`arrays-to-dicts\`, scalar contract-role lists should become dictionaries
  with empty object members.
- In \`arrays-to-dicts\`, if you cannot name either a contract-role child key
  field with non-key payload or a scalar contract-role list, the correct
  verdict is PASS.
- In \`arrays-to-dicts\`, an explicit child key is not enough; reject dictionary
  conversion when that key is item_identity rather than contract_role.
- If you reject, include whether the relevant key/member identity is
  item_identity or contract_role in the rejection context.

## Output format

Output EXACTLY one of the following verdict lines on its own line:

  VERDICT: PASS
  VERDICT: REJECT

If REJECT, follow with a short findings summary, then a section starting with
\`REJECTION CONTEXT:\` containing the specific corrections the fixer
should apply in the next suggest round. Be concrete and obligation-based: list
the exact \`sourcePath\` entries that still need normalization, the exact
\`suggestedCanonical\` each should use, and any entry that should be cleared
back to no \`suggestedCanonical\`.

Begin.`;
}

export function validateShapeNormalizeOutput(
	input: PageShapeNormalizeInput,
	output: ClassifierOutput,
): ShapeNormalizeValidationResult {
	const errors: string[] = [];
	const expected = new Map(
		input.chromePaths.map((entry) => [entry.sourcePath, entry]),
	);
	const seen = new Set<string>();

	for (const entry of output.chromePaths) {
		if (!expected.has(entry.sourcePath)) {
			errors.push(`Unknown sourcePath: "${entry.sourcePath}"`);
			continue;
		}
		if (seen.has(entry.sourcePath)) {
			errors.push(`Duplicate sourcePath: "${entry.sourcePath}"`);
			continue;
		}
		seen.add(entry.sourcePath);
		if (
			entry.suggestedCanonical !== undefined &&
			!CANONICAL_NAME_RE.test(entry.suggestedCanonical)
		) {
			errors.push(
				`suggestedCanonical contains unsupported characters: "${entry.suggestedCanonical}"`,
			);
		}
	}

	for (const sourcePath of expected.keys()) {
		if (!seen.has(sourcePath)) {
			errors.push(`Missing sourcePath from output: "${sourcePath}"`);
		}
	}

	return { valid: errors.length === 0, errors };
}

export function parseShapeNormalizeOpsOutput(
	response: string,
): ShapeNormalizeOpsOutput | undefined {
	try {
		const parsed = JSON.parse(extractJsonObject(response)) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const ops = (parsed as { ops?: unknown }).ops;
		if (!Array.isArray(ops)) return undefined;
		return { ops: ops as ShapeNormalizeOp[] };
	} catch {
		return undefined;
	}
}

export function parseShapeNormalizeIntentOutput(
	response: string,
): ShapeNormalizeIntentOutput | undefined {
	try {
		const parsed = JSON.parse(extractJsonObject(response)) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const intents = (parsed as { intents?: unknown }).intents;
		if (!Array.isArray(intents)) return undefined;
		return { intents: intents as ShapeNormalizeIntent[] };
	} catch {
		return undefined;
	}
}

export function parseShapeNormalizeIntentDecisionOutput(
	response: string,
): ShapeNormalizeIntentDecisionOutput | undefined {
	try {
		const parsed = JSON.parse(extractJsonObject(response)) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const decisions = (parsed as { decisions?: unknown }).decisions;
		if (!Array.isArray(decisions)) return undefined;
		return { decisions: decisions as ShapeNormalizeIntentDecision[] };
	} catch {
		return undefined;
	}
}

function extractJsonObject(response: string): string {
	const trimmed = response.trim();
	if (trimmed.startsWith("```")) {
		const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (fenced) return fenced[1].trim();
	}
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
	return trimmed;
}

export function validateShapeNormalizeOps(
	input: PageShapeNormalizeInput,
	current: ClassifierOutput,
	output: ShapeNormalizeOpsOutput,
	pass: ShapeNormalizePass,
): ShapeNormalizeValidationResult {
	const errors: string[] = [];
	const expected = new Map(
		input.chromePaths.map((entry) => [entry.sourcePath, entry]),
	);
	const currentBySource = new Map(
		current.chromePaths.map((entry) => [entry.sourcePath, entry]),
	);
	const seen = new Set<string>();

	for (const [index, op] of output.ops.entries()) {
		const opErrors = validateShapeNormalizeOp({
			op,
			index,
			expected,
			currentBySource,
			seen,
			pass,
			sourceChrome: input.chrome,
		});
		errors.push(...opErrors);
	}

	return { valid: errors.length === 0, errors };
}

export function validateShapeNormalizeIntents(
	output: ShapeNormalizeIntentOutput,
	pass: ShapeNormalizePass,
): ShapeNormalizeValidationResult {
	const errors: string[] = [];
	const seenIds = new Set<string>();
	for (const [index, intent] of output.intents.entries()) {
		const baseValid = validateIntentEnvelope(intent, index, seenIds, errors);
		if (!baseValid) {
			continue;
		}
		errors.push(...validateIntentForPass(intent, index, pass));
	}
	return { valid: errors.length === 0, errors };
}

function validateIntentEnvelope(
	intent: ShapeNormalizeIntent,
	index: number,
	seenIds: Set<string>,
	errors: string[],
): boolean {
	if (!intent || typeof intent !== "object") {
		errors.push(`Intent ${index} is not an object`);
		return false;
	}
	if (!intent.id || typeof intent.id !== "string") {
		errors.push(`Intent ${index} requires id`);
	} else if (seenIds.has(intent.id)) {
		errors.push(`Duplicate intent id: "${intent.id}"`);
	} else {
		seenIds.add(intent.id);
	}
	if (!intent.reason || typeof intent.reason !== "string") {
		errors.push(`Intent ${index} requires reason`);
	}
	return true;
}

function validateIntentForPass(
	intent: ShapeNormalizeIntent,
	index: number,
	pass: ShapeNormalizePass,
): string[] {
	switch (pass.id) {
		case "arrays-from-objects":
			return validateArrayFromObjectIntent(intent, index);
		case "arrays-to-dicts":
			return validateArrayToDictIntent(intent, index);
		case "structure-names":
		case "leaf-names":
			return validateCanonicalRenameIntent(intent, index);
		default:
			return [`Intent ${index} is not allowed in pass "${pass.id}"`];
	}
}

function validateArrayFromObjectIntent(
	intent: ShapeNormalizeIntent,
	index: number,
): string[] {
	const errors: string[] = [];
	if (intent.kind !== "array-from-object") {
		return [`Intent ${index} must be array-from-object in this pass`];
	}
	errors.push(
		...validateCanonicalFields(index, "Intent", [
			["sourceObjectPath", intent.sourceObjectPath],
			["toArrayPath", intent.toArrayPath],
		]),
	);
	errors.push(...validateCanonicalPathList(index, intent.memberPaths));
	return errors;
}

function validateCanonicalRenameIntent(
	intent: ShapeNormalizeIntent,
	index: number,
): string[] {
	if (intent.kind !== "set-canonical" && intent.kind !== "clear-canonical") {
		return [
			`Intent ${index} must be set-canonical or clear-canonical in this pass`,
		];
	}
	const fields: Array<readonly [string, unknown]> = [
		["sourcePath", intent.sourcePath],
	];
	if (intent.kind === "set-canonical") {
		fields.push(["toSuggestedCanonical", intent.toSuggestedCanonical]);
	}
	return validateCanonicalFields(index, "Intent", fields);
}

function validateArrayToDictIntent(
	intent: ShapeNormalizeIntent,
	index: number,
): string[] {
	const errors: string[] = [];
	if (intent.kind === "scalar-array-to-dict") {
		errors.push(
			...validateCanonicalFields(index, "Intent", [
				["sourceArrayPath", intent.sourceArrayPath],
				["toObjectPath", intent.toObjectPath],
			]),
		);
		return errors;
	}
	if (intent.kind !== "array-to-dict") {
		return [
			`Intent ${index} must be array-to-dict or scalar-array-to-dict in this pass`,
		];
	}
	errors.push(
		...validateCanonicalFields(index, "Intent", [
			["sourceArrayPath", intent.sourceArrayPath],
			["keyField", intent.keyField],
			["toObjectPath", intent.toObjectPath],
		]),
	);
	if (INVALID_ARRAY_TO_DICT_KEY_FIELDS.has(intent.keyField)) {
		errors.push(
			`Intent ${index} array-to-dict requires an explicit child key field, not "${intent.keyField}"`,
		);
	}
	return errors;
}

function validateCanonicalFields(
	index: number,
	subject: string,
	fields: Array<readonly [string, unknown]>,
): string[] {
	const errors: string[] = [];
	for (const [field, value] of fields) {
		if (!value || typeof value !== "string") {
			errors.push(`${subject} ${index} requires ${field}`);
		} else if (!CANONICAL_NAME_RE.test(value)) {
			errors.push(
				`${subject} ${index} ${field} contains unsupported characters`,
			);
		}
	}
	return errors;
}

function validateCanonicalPathList(index: number, value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		return [`Intent ${index} requires non-empty memberPaths`];
	}
	const errors: string[] = [];
	for (const memberPath of value) {
		if (!memberPath || typeof memberPath !== "string") {
			errors.push(`Intent ${index} memberPaths must contain strings`);
		} else if (!CANONICAL_NAME_RE.test(memberPath)) {
			errors.push(
				`Intent ${index} memberPath contains unsupported characters: "${memberPath}"`,
			);
		}
	}
	return errors;
}

export function validateShapeNormalizeIntentDecisions(
	intents: ShapeNormalizeIntentOutput,
	output: ShapeNormalizeIntentDecisionOutput,
): ShapeNormalizeValidationResult {
	const errors: string[] = [];
	const expectedIds = new Set(intents.intents.map((intent) => intent.id));
	const seenIds = new Set<string>();
	for (const [index, decision] of output.decisions.entries()) {
		errors.push(
			...validateShapeNormalizeIntentDecision(
				decision,
				index,
				expectedIds,
				seenIds,
			),
		);
	}
	for (const intentId of expectedIds) {
		if (!seenIds.has(intentId)) {
			errors.push(`Missing decision for intentId "${intentId}"`);
		}
	}
	return { valid: errors.length === 0, errors };
}

function validateShapeNormalizeIntentDecision(
	decision: ShapeNormalizeIntentDecision,
	index: number,
	expectedIds: Set<string>,
	seenIds: Set<string>,
): string[] {
	if (!decision || typeof decision !== "object") {
		return [`Decision ${index} is not an object`];
	}
	const errors: string[] = [];
	if (!expectedIds.has(decision.intentId)) {
		errors.push(`Decision ${index} references unknown intentId`);
	} else if (seenIds.has(decision.intentId)) {
		errors.push(`Duplicate decision for intentId "${decision.intentId}"`);
	} else {
		seenIds.add(decision.intentId);
	}
	if (decision.decision !== "accept" && decision.decision !== "reject") {
		errors.push(`Decision ${index} must be accept or reject`);
	}
	if (!decision.reason || typeof decision.reason !== "string") {
		errors.push(`Decision ${index} requires reason`);
	}
	return errors;
}

function acceptedIntentsInOrder(
	intents: ShapeNormalizeIntentOutput,
	decisions: ShapeNormalizeIntentDecisionOutput,
): ShapeNormalizeIntent[] {
	const acceptedIds = new Set(
		decisions.decisions
			.filter((decision) => decision.decision === "accept")
			.map((decision) => decision.intentId),
	);
	return intents.intents.filter((intent) => acceptedIds.has(intent.id));
}

function validateShapeNormalizeOp(args: {
	op: ShapeNormalizeOp;
	index: number;
	expected: Map<string, ClassifierPathEntry>;
	currentBySource: Map<string, ClassifierPathEntry>;
	seen: Set<string>;
	pass: ShapeNormalizePass;
	sourceChrome: unknown;
}): string[] {
	const { op, index, expected, currentBySource, seen, pass, sourceChrome } =
		args;
	if (!op || typeof op !== "object") return [`Op ${index} is not an object`];
	if (
		op.kind !== "set-suggested-canonical" &&
		op.kind !== "clear-suggested-canonical" &&
		op.kind !== "reshape-array-to-dict" &&
		op.kind !== "reshape-object-to-array" &&
		op.kind !== "reshape-scalar-array-to-dict"
	) {
		return [`Op ${index} has unsupported kind: "${op.kind}"`];
	}
	if (op.kind === "reshape-object-to-array") {
		return validateObjectToArrayOp(op, index, expected, pass);
	}
	if (op.kind === "reshape-array-to-dict") {
		return validateArrayToDictOp(op, index, expected, pass, sourceChrome);
	}
	if (op.kind === "reshape-scalar-array-to-dict") {
		return validateScalarArrayToDictOp(op, index, expected, pass, sourceChrome);
	}
	if (!expected.has(op.sourcePath)) {
		return [`Op ${index} references unknown sourcePath: "${op.sourcePath}"`];
	}
	if (seen.has(op.sourcePath)) {
		return [`Duplicate op for sourcePath: "${op.sourcePath}"`];
	}
	seen.add(op.sourcePath);

	const errors: string[] = [];
	if (!op.reason || typeof op.reason !== "string") {
		errors.push(`Op ${index} must include a reason`);
	}
	if (op.fromSuggestedCanonical !== undefined) {
		errors.push(
			`Op ${index} must not include fromSuggestedCanonical; it is derived programmatically`,
		);
	}
	if (op.kind === "set-suggested-canonical") {
		errors.push(...validateSetSuggestedCanonicalOp(op, index, currentBySource));
	} else {
		errors.push(
			...validateClearSuggestedCanonicalOp(op, index, currentBySource, pass),
		);
	}
	return errors;
}

function validateScalarArrayToDictOp(
	op: ShapeNormalizeScalarArrayToDictOp,
	index: number,
	expected: Map<string, ClassifierPathEntry>,
	pass: ShapeNormalizePass,
	sourceChrome: unknown,
): string[] {
	const errors: string[] = [];
	if (pass.id !== "arrays-to-dicts") {
		errors.push(
			`Op ${index} reshape-scalar-array-to-dict is only allowed in the array rollback pass`,
		);
	}
	if (!op.reason || typeof op.reason !== "string") {
		errors.push(`Op ${index} must include a reason`);
	}
	for (const [field, value] of [
		["sourceArrayPath", op.sourceArrayPath],
		["toObjectPath", op.toObjectPath],
	] as const) {
		if (!value || typeof value !== "string") {
			errors.push(`Op ${index} reshape-scalar-array-to-dict requires ${field}`);
		} else if (!CANONICAL_NAME_RE.test(value)) {
			errors.push(
				`Op ${index} ${field} contains unsupported characters: "${value}"`,
			);
		}
	}
	const scalarPaths = collectScalarArrayPaths(
		expected.keys(),
		op.sourceArrayPath,
	);
	if (scalarPaths.length === 0) {
		errors.push(
			`Op ${index} found no scalar array paths like "${op.sourceArrayPath}[N]"`,
		);
	}
	errors.push(...validateScalarArrayKeys(index, scalarPaths, sourceChrome));
	return errors;
}

function validateSetSuggestedCanonicalOp(
	op: ShapeNormalizeCanonicalOp,
	index: number,
	currentBySource: Map<string, ClassifierPathEntry>,
): string[] {
	const errors: string[] = [];
	if (!op.toSuggestedCanonical || typeof op.toSuggestedCanonical !== "string") {
		errors.push(
			`Op ${index} set-suggested-canonical requires toSuggestedCanonical`,
		);
	} else if (!CANONICAL_NAME_RE.test(op.toSuggestedCanonical)) {
		errors.push(
			`Op ${index} toSuggestedCanonical contains unsupported characters: "${op.toSuggestedCanonical}"`,
		);
	}
	if (
		op.toSuggestedCanonical ===
		currentBySource.get(op.sourcePath)?.suggestedCanonical
	) {
		errors.push(`Op ${index} does not change "${op.sourcePath}"`);
	}
	return errors;
}

function validateClearSuggestedCanonicalOp(
	op: ShapeNormalizeCanonicalOp,
	index: number,
	currentBySource: Map<string, ClassifierPathEntry>,
	pass: ShapeNormalizePass,
): string[] {
	const errors: string[] = [];
	if (op.toSuggestedCanonical !== undefined) {
		errors.push(
			`Op ${index} clear-suggested-canonical must not include toSuggestedCanonical`,
		);
	}
	if (currentBySource.get(op.sourcePath)?.suggestedCanonical === undefined) {
		errors.push(
			`Op ${index} cannot clear "${op.sourcePath}" because it has no current suggestedCanonical`,
		);
	}
	if (pass.id !== "arrays-to-dicts") {
		errors.push(
			`Op ${index} clears "${op.sourcePath}" outside the array rollback pass`,
		);
	}
	return errors;
}

function validateObjectToArrayOp(
	op: ShapeNormalizeObjectToArrayOp,
	index: number,
	expected: Map<string, ClassifierPathEntry>,
	pass: ShapeNormalizePass,
): string[] {
	const errors: string[] = [];
	if (pass.id !== "arrays-from-objects") {
		errors.push(
			`Op ${index} reshape-object-to-array is only allowed in the array conversion pass`,
		);
	}
	if (!op.reason || typeof op.reason !== "string") {
		errors.push(`Op ${index} must include a reason`);
	}
	errors.push(
		...validateObjectToArrayRequiredFields(op, index),
		...validateObjectToArrayMembers(op, index, expected),
	);
	return errors;
}

function validateObjectToArrayRequiredFields(
	op: ShapeNormalizeObjectToArrayOp,
	index: number,
): string[] {
	const errors: string[] = [];
	for (const [field, value] of [
		["sourceObjectPath", op.sourceObjectPath],
		["toArrayPath", op.toArrayPath],
	] as const) {
		if (!value || typeof value !== "string") {
			errors.push(`Op ${index} reshape-object-to-array requires ${field}`);
		} else if (!CANONICAL_NAME_RE.test(value)) {
			errors.push(
				`Op ${index} ${field} contains unsupported characters: "${value}"`,
			);
		}
	}
	return errors;
}

function validateObjectToArrayMembers(
	op: ShapeNormalizeObjectToArrayOp,
	index: number,
	expected: Map<string, ClassifierPathEntry>,
): string[] {
	if (
		!Array.isArray(op.sourceMemberPaths) ||
		op.sourceMemberPaths.length === 0
	) {
		return [`Op ${index} reshape-object-to-array requires sourceMemberPaths`];
	}
	const errors: string[] = [];
	const seenMembers = new Set<string>();
	for (const memberPath of op.sourceMemberPaths) {
		errors.push(
			...validateObjectToArrayMember(
				op,
				index,
				expected,
				seenMembers,
				memberPath,
			),
		);
	}
	return errors;
}

function validateObjectToArrayMember(
	op: ShapeNormalizeObjectToArrayOp,
	index: number,
	expected: Map<string, ClassifierPathEntry>,
	seenMembers: Set<string>,
	memberPath: unknown,
): string[] {
	if (!memberPath || typeof memberPath !== "string") {
		return [`Op ${index} sourceMemberPaths must contain strings`];
	}
	const errors: string[] = [];
	if (!CANONICAL_NAME_RE.test(memberPath)) {
		errors.push(
			`Op ${index} sourceMemberPath contains unsupported characters: "${memberPath}"`,
		);
	}
	if (seenMembers.has(memberPath)) {
		errors.push(`Op ${index} duplicate sourceMemberPath "${memberPath}"`);
	}
	seenMembers.add(memberPath);
	if (
		op.sourceObjectPath &&
		memberPath !== op.sourceObjectPath &&
		!memberPath.startsWith(`${op.sourceObjectPath}.`)
	) {
		errors.push(
			`Op ${index} sourceMemberPath "${memberPath}" is not under sourceObjectPath "${op.sourceObjectPath}"`,
		);
	}
	if (!expected.has(memberPath) && !hasSourcePathChild(expected, memberPath)) {
		errors.push(
			`Op ${index} sourceMemberPath "${memberPath}" has no sourcePath children`,
		);
	}
	return errors;
}

function hasSourcePathChild(
	expected: Map<string, ClassifierPathEntry>,
	parentPath: string,
): boolean {
	return Array.from(expected.keys()).some((sourcePath) =>
		sourcePath.startsWith(`${parentPath}.`),
	);
}

function validateArrayToDictOp(
	op: ShapeNormalizeArrayToDictOp,
	index: number,
	expected: Map<string, ClassifierPathEntry>,
	pass: ShapeNormalizePass,
	sourceChrome: unknown,
): string[] {
	const errors: string[] = [];
	if (pass.id !== "arrays-to-dicts") {
		errors.push(
			`Op ${index} reshape-array-to-dict is only allowed in the array rollback pass`,
		);
	}
	if (!op.reason || typeof op.reason !== "string") {
		errors.push(`Op ${index} must include a reason`);
	}
	errors.push(...validateArrayToDictRequiredFields(op, index));
	if (INVALID_ARRAY_TO_DICT_KEY_FIELDS.has(op.keyField)) {
		errors.push(
			`Op ${index} reshape-array-to-dict requires an explicit child key field, not "${op.keyField}"`,
		);
	}
	const keyPaths = collectArrayToDictKeyPaths(expected.keys(), op);
	if (keyPaths.length === 0) {
		errors.push(
			`Op ${index} found no key field paths like "${op.sourceArrayPath}[N].${op.keyField}"`,
		);
	}
	errors.push(...validateArrayToDictKeys(index, keyPaths, sourceChrome));
	errors.push(
		...validateArrayToDictPayload(index, keyPaths, expected.keys(), op),
	);
	return errors;
}

function validateArrayToDictRequiredFields(
	op: ShapeNormalizeArrayToDictOp,
	index: number,
): string[] {
	const errors: string[] = [];
	for (const [field, value] of [
		["sourceArrayPath", op.sourceArrayPath],
		["keyField", op.keyField],
		["toObjectPath", op.toObjectPath],
	] as const) {
		if (!value || typeof value !== "string") {
			errors.push(`Op ${index} reshape-array-to-dict requires ${field}`);
		} else if (!CANONICAL_NAME_RE.test(value)) {
			errors.push(
				`Op ${index} ${field} contains unsupported characters: "${value}"`,
			);
		}
	}
	return errors;
}

function validateArrayToDictKeys(
	index: number,
	keyPaths: Array<{ collectionKey: string; sourcePath: string }>,
	sourceChrome: unknown,
): string[] {
	const errors: string[] = [];
	const seenKeysByCollection = new Map<string, Set<string>>();
	for (const { collectionKey, sourcePath } of keyPaths) {
		const keyValue = readPath(sourceChrome, sourcePath);
		if (typeof keyValue !== "string" && typeof keyValue !== "number") {
			errors.push(
				`Op ${index} key sourcePath "${sourcePath}" must resolve to a string or number`,
			);
			continue;
		}
		const key = pathSegmentFromValue(keyValue);
		if (!key) {
			errors.push(
				`Op ${index} key sourcePath "${sourcePath}" produced an empty key`,
			);
			continue;
		}
		let seenKeys = seenKeysByCollection.get(collectionKey);
		if (!seenKeys) {
			seenKeys = new Set();
			seenKeysByCollection.set(collectionKey, seenKeys);
		}
		if (seenKeys.has(key)) {
			errors.push(
				`Op ${index} duplicate dictionary key "${key}" in "${collectionKey}"`,
			);
		}
		seenKeys.add(key);
	}
	return errors;
}

function validateArrayToDictPayload(
	index: number,
	keyPaths: Array<{ collectionKey: string; index: number; sourcePath: string }>,
	sourcePaths: Iterable<string>,
	op: ShapeNormalizeArrayToDictOp,
): string[] {
	const payloadPaths = collectArrayToDictPayloadPaths(sourcePaths, op);
	const payloadByItem = new Set(
		payloadPaths.map(({ collectionKey, index: itemIndex }) =>
			arrayDictItemKey(collectionKey, itemIndex),
		),
	);
	const errors: string[] = [];
	for (const keyPath of keyPaths) {
		const itemKey = arrayDictItemKey(keyPath.collectionKey, keyPath.index);
		if (payloadByItem.has(itemKey)) continue;
		errors.push(
			`Op ${index} item "${keyPath.sourcePath}" has no non-key payload; array-to-dict requires payload beyond "${op.keyField}"`,
		);
	}
	return errors;
}

function validateScalarArrayKeys(
	index: number,
	scalarPaths: Array<{
		collectionKey: string;
		index: number;
		sourcePath: string;
	}>,
	sourceChrome: unknown,
): string[] {
	const errors: string[] = [];
	const seenKeysByCollection = new Map<string, Set<string>>();
	for (const { collectionKey, sourcePath } of scalarPaths) {
		const keyValue = readPath(sourceChrome, sourcePath);
		if (typeof keyValue !== "string" && typeof keyValue !== "number") {
			errors.push(
				`Op ${index} scalar sourcePath "${sourcePath}" must resolve to a string or number`,
			);
			continue;
		}
		const key = pathSegmentFromValue(keyValue);
		if (!key) {
			errors.push(
				`Op ${index} scalar sourcePath "${sourcePath}" produced an empty key`,
			);
			continue;
		}
		let seenKeys = seenKeysByCollection.get(collectionKey);
		if (!seenKeys) {
			seenKeys = new Set();
			seenKeysByCollection.set(collectionKey, seenKeys);
		}
		if (seenKeys.has(key)) {
			errors.push(
				`Op ${index} duplicate dictionary key "${key}" in "${collectionKey}"`,
			);
		}
		seenKeys.add(key);
	}
	return errors;
}

function collectScalarArrayPaths(
	sourcePaths: Iterable<string>,
	sourceArrayPath: string,
): Array<{ collectionKey: string; index: number; sourcePath: string }> {
	const sourceArrayPattern = sourceArrayPath
		.split("[*]")
		.map(escapeRegExp)
		.join("\\[(?:\\d+)\\]");
	const re = new RegExp(`^(${sourceArrayPattern})\\[(\\d+)\\]$`);
	const out: Array<{
		collectionKey: string;
		index: number;
		sourcePath: string;
	}> = [];
	for (const sourcePath of sourcePaths) {
		const match = sourcePath.match(re);
		if (!match) continue;
		out.push({
			collectionKey: match[1],
			index: Number(match[2]),
			sourcePath,
		});
	}
	return out.sort((a, b) =>
		a.collectionKey === b.collectionKey
			? a.index - b.index
			: a.collectionKey < b.collectionKey
				? -1
				: 1,
	);
}

function collectArrayToDictKeyPaths(
	sourcePaths: Iterable<string>,
	op: ShapeNormalizeArrayToDictOp,
): Array<{ collectionKey: string; index: number; sourcePath: string }> {
	const out: Array<{
		collectionKey: string;
		index: number;
		sourcePath: string;
	}> = [];
	for (const sourcePath of sourcePaths) {
		const match = matchArrayChildPath(sourcePath, op.sourceArrayPath);
		if (!match || match.relativePath !== op.keyField) continue;
		out.push({
			collectionKey: match.collectionKey,
			index: match.index,
			sourcePath,
		});
	}
	return out.sort((a, b) =>
		a.collectionKey === b.collectionKey
			? a.index - b.index
			: a.collectionKey < b.collectionKey
				? -1
				: 1,
	);
}

function collectArrayToDictPayloadPaths(
	sourcePaths: Iterable<string>,
	op: ShapeNormalizeArrayToDictOp,
): Array<{
	collectionKey: string;
	index: number;
	sourcePath: string;
	relativePath: string;
}> {
	const out: Array<{
		collectionKey: string;
		index: number;
		sourcePath: string;
		relativePath: string;
	}> = [];
	for (const sourcePath of sourcePaths) {
		const match = matchArrayChildPath(sourcePath, op.sourceArrayPath);
		if (!match) continue;
		if (
			match.relativePath === op.keyField ||
			match.relativePath.startsWith(`${op.keyField}.`)
		) {
			continue;
		}
		out.push({
			collectionKey: match.collectionKey,
			index: match.index,
			sourcePath,
			relativePath: match.relativePath,
		});
	}
	return out.sort(compareArrayToDictPayloadPath);
}

function compareArrayToDictPayloadPath(
	a: {
		collectionKey: string;
		index: number;
		relativePath: string;
	},
	b: {
		collectionKey: string;
		index: number;
		relativePath: string;
	},
): number {
	if (a.collectionKey !== b.collectionKey) {
		return a.collectionKey < b.collectionKey ? -1 : 1;
	}
	if (a.index !== b.index) return a.index - b.index;
	if (a.relativePath < b.relativePath) return -1;
	if (a.relativePath > b.relativePath) return 1;
	return 0;
}

function matchArrayChildPath(
	sourcePath: string,
	sourceArrayPath: string,
): { collectionKey: string; index: number; relativePath: string } | undefined {
	const sourceArrayPattern = sourceArrayPath
		.split("[*]")
		.map(escapeRegExp)
		.join("\\[(?:\\d+)\\]");
	const re = new RegExp(`^(${sourceArrayPattern})\\[(\\d+)\\]\\.(.+)$`);
	const match = sourcePath.match(re);
	if (!match) return undefined;
	return {
		collectionKey: match[1],
		index: Number(match[2]),
		relativePath: match[3],
	};
}

function pathSegmentFromValue(value: string | number): string {
	return String(value)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyShapeNormalizeOps(
	current: ClassifierOutput,
	ops: ShapeNormalizeOpsOutput,
	sourceChrome?: unknown,
): ClassifierOutput {
	const bySource = new Map(
		current.chromePaths.map((entry) => [entry.sourcePath, { ...entry }]),
	);
	for (const op of ops.ops) {
		if (op.kind === "reshape-object-to-array") {
			applyObjectToArrayOp(bySource, op);
			continue;
		}
		if (op.kind === "reshape-array-to-dict") {
			applyArrayToDictOp(bySource, op, sourceChrome);
			continue;
		}
		if (op.kind === "reshape-scalar-array-to-dict") {
			applyScalarArrayToDictOp(bySource, op, sourceChrome);
			continue;
		}
		const entry = bySource.get(op.sourcePath);
		if (!entry) continue;
		if (op.kind === "set-suggested-canonical") {
			entry.suggestedCanonical = op.toSuggestedCanonical;
			delete entry.materializeAs;
		} else {
			delete entry.suggestedCanonical;
			delete entry.materializeAs;
		}
	}
	return {
		chromePaths: current.chromePaths.map(
			(entry) => bySource.get(entry.sourcePath) ?? entry,
		),
	};
}

export function applyArrayRepresentationBaseline(
	current: ClassifierOutput,
): ClassifierOutput {
	return {
		chromePaths: current.chromePaths.map((entry) => {
			const candidate = entry.suggestedCanonical ?? entry.sourcePath;
			const collapsed = collapseArrayIndices(candidate);
			if (collapsed === candidate) return { ...entry };
			return {
				...entry,
				suggestedCanonical: collapsed,
			};
		}),
	};
}

function applyObjectToArrayOp(
	bySource: Map<string, ClassifierPathEntry>,
	op: ShapeNormalizeObjectToArrayOp,
): void {
	for (const entry of bySource.values()) {
		const match = matchObjectMemberChildPath(
			entry.sourcePath,
			op.sourceMemberPaths,
		);
		if (!match) continue;
		entry.suggestedCanonical = match.relativePath
			? `${op.toArrayPath}[*].${match.relativePath}`
			: `${op.toArrayPath}[*]`;
		entry.materializeAs = "value";
	}
}

function matchObjectMemberChildPath(
	sourcePath: string,
	memberPaths: string[],
): { memberPath: string; relativePath?: string } | undefined {
	for (const memberPath of memberPaths) {
		if (sourcePath === memberPath) {
			return { memberPath };
		}
		const prefix = `${memberPath}.`;
		if (sourcePath.startsWith(prefix)) {
			return {
				memberPath,
				relativePath: sourcePath.slice(prefix.length),
			};
		}
	}
	return undefined;
}

function applyArrayToDictOp(
	bySource: Map<string, ClassifierPathEntry>,
	op: ShapeNormalizeArrayToDictOp,
	sourceChrome: unknown,
): void {
	const keyByItem = new Map<string, string>();
	for (const { collectionKey, index, sourcePath } of collectArrayToDictKeyPaths(
		bySource.keys(),
		op,
	)) {
		const keyValue = readPath(sourceChrome, sourcePath);
		if (typeof keyValue !== "string" && typeof keyValue !== "number") continue;
		const key = pathSegmentFromValue(keyValue);
		if (key) keyByItem.set(arrayDictItemKey(collectionKey, index), key);
	}
	for (const entry of bySource.values()) {
		const match = matchArrayChildPath(entry.sourcePath, op.sourceArrayPath);
		if (!match) continue;
		const key = keyByItem.get(
			arrayDictItemKey(match.collectionKey, match.index),
		);
		if (!key) continue;
		if (match.relativePath === op.keyField && op.omitKeyField !== false) {
			entry.suggestedCanonical = `${op.toObjectPath}.${key}`;
			entry.materializeAs = "identity-key";
			continue;
		}
		entry.suggestedCanonical = `${op.toObjectPath}.${key}.${match.relativePath}`;
		entry.materializeAs = "value";
	}
}

function applyScalarArrayToDictOp(
	bySource: Map<string, ClassifierPathEntry>,
	op: ShapeNormalizeScalarArrayToDictOp,
	sourceChrome: unknown,
): void {
	for (const { sourcePath } of collectScalarArrayPaths(
		bySource.keys(),
		op.sourceArrayPath,
	)) {
		const keyValue = readPath(sourceChrome, sourcePath);
		if (typeof keyValue !== "string" && typeof keyValue !== "number") continue;
		const key = pathSegmentFromValue(keyValue);
		if (!key) continue;
		const entry = bySource.get(sourcePath);
		if (!entry) continue;
		entry.suggestedCanonical = `${op.toObjectPath}.${key}`;
		entry.materializeAs = "empty-object";
	}
}

function arrayDictItemKey(collectionKey: string, index: number): string {
	return `${collectionKey}[${index}]`;
}

export function deriveAppliedShapeNormalizeOps(
	before: ClassifierOutput,
	after: ClassifierOutput,
	raw: ShapeNormalizeOpsOutput,
): ShapeNormalizeOpsOutput {
	const beforeBySource = new Map(
		before.chromePaths.map((entry) => [entry.sourcePath, entry]),
	);
	const afterBySource = new Map(
		after.chromePaths.map((entry) => [entry.sourcePath, entry]),
	);
	return {
		ops: raw.ops.map((op) => {
			if (
				op.kind === "reshape-array-to-dict" ||
				op.kind === "reshape-object-to-array" ||
				op.kind === "reshape-scalar-array-to-dict"
			) {
				return op;
			}
			const beforeEntry = beforeBySource.get(op.sourcePath);
			const afterEntry = afterBySource.get(op.sourcePath);
			return {
				...op,
				...(beforeEntry?.suggestedCanonical !== undefined
					? { fromSuggestedCanonical: beforeEntry.suggestedCanonical }
					: {}),
				...(op.kind === "set-suggested-canonical"
					? { toSuggestedCanonical: afterEntry?.suggestedCanonical }
					: {}),
			};
		}),
	};
}

function validateShapeMaterialization(
	sourceChrome: unknown,
	output: ClassifierOutput,
	materialized: ShapeMaterializeResult,
): ShapeNormalizeValidationResult {
	const errors: string[] = [];
	if (materialized.collisions.length > 0) {
		for (const collision of materialized.collisions) {
			errors.push(
				`Materialization collision at "${collision.materializedPath}" from "${collision.firstSourcePath}" and "${collision.secondSourcePath}"`,
			);
		}
	}
	if (materialized.provenance.length !== output.chromePaths.length) {
		errors.push(
			`Materialization provenance count ${materialized.provenance.length} does not match sourcePath count ${output.chromePaths.length}`,
		);
	}
	for (const entry of materialized.provenance) {
		errors.push(
			...validateMaterializedProvenanceEntry(sourceChrome, materialized, entry),
		);
	}
	for (const sparsePath of findSparseArrays(materialized.chrome)) {
		errors.push(`Materialization created sparse array at "${sparsePath}"`);
	}
	return { valid: errors.length === 0, errors };
}

function validateMaterializedProvenanceEntry(
	sourceChrome: unknown,
	materialized: ShapeMaterializeResult,
	entry: ShapeMaterializeResult["provenance"][number],
): string[] {
	if (entry.role === "identity-key") return [];
	if (entry.role === "empty-object") {
		if (!entry.materializedPath) {
			return [
				`Materialization provenance is missing materializedPath for "${entry.sourcePath}"`,
			];
		}
		const targetValue = readPath(materialized.chrome, entry.materializedPath);
		if (
			!targetValue ||
			typeof targetValue !== "object" ||
			Array.isArray(targetValue) ||
			Object.keys(targetValue).length > 0
		) {
			return [
				`Materialization empty-object target is missing or non-empty: "${entry.materializedPath}"`,
			];
		}
		return [];
	}
	if (!entry.materializedPath) {
		return [
			`Materialization provenance is missing materializedPath for "${entry.sourcePath}"`,
		];
	}
	const sourceValue = readPath(sourceChrome, entry.sourcePath);
	if (sourceValue === undefined) {
		return [`Materialization sourcePath is missing: "${entry.sourcePath}"`];
	}
	const targetValue = readPath(materialized.chrome, entry.materializedPath);
	if (targetValue === undefined) {
		return [
			`Materialization targetPath is missing: "${entry.materializedPath}"`,
		];
	}
	if (JSON.stringify(sourceValue) !== JSON.stringify(targetValue)) {
		return [
			`Materialization changed value from "${entry.sourcePath}" to "${entry.materializedPath}"`,
		];
	}
	return [];
}

function findSparseArrays(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) return findSparseArraysInArray(value, path);
	if (value !== null && typeof value === "object") {
		return findSparseArraysInObject(value as Record<string, unknown>, path);
	}
	return [];
}

function findSparseArraysInArray(value: unknown[], path: string): string[] {
	const out = isSparseArray(value) ? [path || "<root>"] : [];
	for (let i = 0; i < value.length; i++) {
		out.push(...findSparseArrays(value[i], `${path}[${i}]`));
	}
	return out;
}

function findSparseArraysInObject(
	value: Record<string, unknown>,
	path: string,
): string[] {
	const out: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		out.push(...findSparseArrays(child, path ? `${path}.${key}` : key));
	}
	return out;
}

function isSparseArray(value: unknown[]): boolean {
	for (let i = 0; i < value.length; i++) {
		if (!(i in value)) return true;
	}
	return false;
}

export function deriveShapeNormalizeOps(
	before: ClassifierOutput,
	after: ClassifierOutput,
): ShapeNormalizeOp[] {
	const beforeBySource = new Map(
		before.chromePaths.map((entry) => [entry.sourcePath, entry]),
	);
	const ops: ShapeNormalizeCanonicalOp[] = [];

	for (const entry of after.chromePaths) {
		const prior = beforeBySource.get(entry.sourcePath);
		if (!prior) continue;
		const prev = prior.suggestedCanonical;
		const next = entry.suggestedCanonical;
		if (prev === next) continue;
		if (next === undefined) {
			ops.push({
				kind: "clear-suggested-canonical",
				sourcePath: entry.sourcePath,
				fromSuggestedCanonical: prev,
				reason: "shape-normalize removed prior suggestedCanonical",
			});
			continue;
		}
		ops.push({
			kind: "set-suggested-canonical",
			sourcePath: entry.sourcePath,
			fromSuggestedCanonical: prev,
			toSuggestedCanonical: next,
			reason: "shape-normalize adjusted canonical path",
		});
	}

	return ops.sort((a, b) =>
		a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0,
	);
}

export async function shapeNormalizeOnePage(
	opts: ShapeNormalizeOnePageOptions,
): Promise<PageShapeNormalizeResult> {
	const { page, runAgent, maxRetries, hooks } = opts;
	const attempts: ShapeNormalizeAttemptRecord[] = [];
	const totals: AgentCallTotals = {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	};
	const initial: ClassifierOutput = {
		chromePaths: page.chromePaths.map((entry) => ({ ...entry })),
	};
	let current = applyArrayRepresentationBaseline(initial);
	const baselineOps = deriveShapeNormalizeOps(initial, current);
	const acceptedOps: ShapeNormalizeOp[] = [...baselineOps];
	let nextAttempt = 0;

	for (const pass of activeShapeNormalizePasses(opts.passIds)) {
		const passResult = await runShapeNormalizePass({
			page,
			pass,
			current,
			runAgent,
			opsWorkdir: opts.opsWorkdir,
			maxRetries,
			hooks,
			attempts,
			totals,
			nextAttempt,
		});
		nextAttempt = passResult.nextAttempt;
		if (passResult.status === "fail") {
			return {
				status: "fail",
				ops: [],
				lastRejection: passResult.lastRejection,
				attempts,
				totals,
			};
		}
		acceptedOps.push(...passResult.ops);
		current = passResult.output;
	}

	return {
		status: "pass",
		output: current,
		ops: acceptedOps,
		attempts,
		totals,
	};
}

function activeShapeNormalizePasses(
	passIds: readonly ShapeNormalizePassId[] | null | undefined,
): readonly ShapeNormalizePass[] {
	if (passIds === undefined || passIds === null) return SHAPE_NORMALIZE_PASSES;
	const allowed = new Set(passIds);
	return SHAPE_NORMALIZE_PASSES.filter((pass) => allowed.has(pass.id));
}

interface RunShapeNormalizePassOptions {
	page: PageShapeNormalizeInput;
	pass: ShapeNormalizePass;
	current: ClassifierOutput;
	runAgent: RunAgentFn;
	opsWorkdir: string;
	maxRetries: number;
	hooks?: ShapeNormalizeAttemptHooks;
	attempts: ShapeNormalizeAttemptRecord[];
	totals: AgentCallTotals;
	nextAttempt: number;
}

type RunShapeNormalizePassResult =
	| {
			status: "pass";
			output: ClassifierOutput;
			ops: ShapeNormalizeOp[];
			nextAttempt: number;
	  }
	| {
			status: "fail";
			lastRejection?: string;
			nextAttempt: number;
	  };

type PreparedShapeOps =
	| {
			ok: true;
			parsed: ShapeNormalizeOpsOutput;
			applied: ClassifierOutput;
			materialized: ShapeMaterializeResult;
	  }
	| {
			ok: false;
			parsed?: ShapeNormalizeOpsOutput;
			error: string;
			rejectionContext: string;
	  };

function prepareShapeOpsCandidate(args: {
	response: string;
	page: PageShapeNormalizeInput;
	current: ClassifierOutput;
	pass: ShapeNormalizePass;
	errorPrefix: string;
}): PreparedShapeOps {
	const { response, page, current, pass, errorPrefix } = args;
	const parsed = parseShapeNormalizeOpsOutput(response);
	if (!parsed) {
		return {
			ok: false,
			error: "unparseable",
			rejectionContext: `${errorPrefix} was not valid JSON matching {"ops":[{"kind":"set-suggested-canonical","sourcePath":"...","toSuggestedCanonical":"...","reason":"..."}]}. Return ONLY that JSON object, no prose or code fences.`,
		};
	}

	const validation = validateShapeNormalizeOps(page, current, parsed, pass);
	if (!validation.valid) {
		return {
			ok: false,
			parsed,
			error: validation.errors.join("; "),
			rejectionContext: `${errorPrefix} failed validation:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
		};
	}

	const applied = applyShapeNormalizeOps(current, parsed, page.chrome);
	const materialized = materializeShapeNormalizedChrome(
		page.chrome,
		applied.chromePaths,
	);
	const materialization = validateShapeMaterialization(
		page.chrome,
		applied,
		materialized,
	);
	if (!materialization.valid) {
		return {
			ok: false,
			parsed,
			error: materialization.errors.join("; "),
			rejectionContext: `${errorPrefix} failed materialization:\n${materialization.errors.map((e) => `  - ${e}`).join("\n")}`,
		};
	}

	return { ok: true, parsed, applied, materialized };
}

async function runShapeNormalizePass(
	opts: RunShapeNormalizePassOptions,
): Promise<RunShapeNormalizePassResult> {
	return runShapeNormalizeIntentPass(opts);
}

async function runShapeNormalizeIntentPass(
	opts: RunShapeNormalizePassOptions,
): Promise<RunShapeNormalizePassResult> {
	const {
		page,
		pass,
		current,
		runAgent,
		opsWorkdir,
		maxRetries,
		hooks,
		attempts,
		totals,
	} = opts;
	let nextAttempt = opts.nextAttempt;
	let working = current;
	const acceptedPassDomainOps: ShapeNormalizeOp[] = [];
	let rejectionContext: string | undefined;
	const maxSuggestRounds = Math.max(maxRetries + 1, 8);

	for (let attempt = 0; attempt < maxSuggestRounds; attempt++) {
		const attemptId = nextAttempt++;
		const intentAttempt = await requestShapeIntentAttempt({
			attemptId,
			page,
			pass,
			working,
			rejectionContext,
			runAgent,
			hooks,
			totals,
		});
		attempts.push(intentAttempt.record);
		if (!intentAttempt.ok) {
			rejectionContext = intentAttempt.rejectionContext;
			continue;
		}

		if (intentAttempt.intents.intents.length === 0) {
			const finalReview = await reviewShapeNormalizePassCompletion({
				attemptId,
				page,
				pass,
				working,
				acceptedPassOps: acceptedPassDomainOps,
				runAgent,
				hooks,
				totals,
			});
			intentAttempt.record.review = finalReview.record;
			if (finalReview.verdict.verdict === "pass") {
				return {
					status: "pass",
					output: working,
					ops: acceptedPassDomainOps,
					nextAttempt,
				};
			}
			rejectionContext =
				finalReview.verdict.rejectionContext ?? finalReview.verdict.findings;
			continue;
		}

		const decision = await requestIntentDecision({
			attemptId,
			page,
			pass,
			working,
			intents: intentAttempt.intents,
			runAgent,
			hooks,
			totals,
		});
		intentAttempt.record.review = decision.record;
		if (!decision.ok) {
			rejectionContext = decision.rejectionContext;
			continue;
		}

		const acceptedIntents = acceptedIntentsInOrder(
			intentAttempt.intents,
			decision.decisions,
		);
		if (acceptedIntents.length === 0) {
			rejectionContext =
				"Main decision rejected every proposed intent. Propose a different clear topology intent or return an empty intents array if no pass work remains.";
			continue;
		}

		const opsified = await materializeAcceptedShapeIntents({
			attemptId,
			page,
			pass,
			working,
			intents: acceptedIntents,
			runAgent,
			opsWorkdir,
			hooks,
			totals,
		});
		intentAttempt.record.fix = opsified.record;
		if (!opsified.ok) {
			rejectionContext = opsified.rejectionContext;
			continue;
		}

		const appliedOps = deriveAppliedShapeNormalizeOps(
			working,
			opsified.prepared.applied,
			opsified.prepared.parsed,
		).ops;
		acceptedPassDomainOps.push(...appliedOps);
		working = opsified.prepared.applied;
		rejectionContext = undefined;
	}

	return {
		status: "fail",
		lastRejection: rejectionContext,
		nextAttempt,
	};
}

async function materializeAcceptedShapeIntents(args: {
	attemptId: number;
	page: PageShapeNormalizeInput;
	pass: ShapeNormalizePass;
	working: ClassifierOutput;
	intents: ShapeNormalizeIntent[];
	runAgent: RunAgentFn;
	opsWorkdir: string;
	hooks?: ShapeNormalizeAttemptHooks;
	totals: AgentCallTotals;
}): Promise<
	| {
			ok: true;
			record: NonNullable<ShapeNormalizeAttemptRecord["fix"]>;
			prepared: Extract<PreparedShapeOps, { ok: true }>;
	  }
	| {
			ok: false;
			record: NonNullable<ShapeNormalizeAttemptRecord["fix"]>;
			rejectionContext: string;
	  }
> {
	const {
		attemptId,
		page,
		pass,
		working,
		intents,
		runAgent,
		opsWorkdir,
		hooks,
		totals,
	} = args;
	const prompt = buildIntentMaterializerTrace(pass, intents);
	await hooks?.beforeFixCall?.(attemptId, prompt);
	const record: NonNullable<ShapeNormalizeAttemptRecord["fix"]> = {
		prompt,
		response: "",
		tokens: { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
	};
	let parsed: ShapeNormalizeOpsOutput;
	try {
		const materialized = await generateDomainOpsBatch<
			ShapeNormalizeIntent,
			ShapeNormalizeOp
		>({
			intents,
			intentToText: (intent, index) =>
				buildShapeIntentMaterializationText({
					index,
					intent,
					page,
					pass,
					working,
				}),
			domain: SHAPE_NORMALIZE_DOMAIN,
			runAgent: makeDomainOpsRunAgent(runAgent),
			workdir: `${opsWorkdir}/${attemptId}/ops-module`,
		});
		addTotals(totals, materialized.totals);
		record.tokens = metricsOf(materialized.totals);
		parsed = { ops: materialized.ops };
		record.response = JSON.stringify(
			{
				ops: materialized.ops,
				intents: materialized.results.map((result) => ({
					index: result.index,
					intent: result.intent,
					ops: result.ops,
				})),
			},
			null,
			2,
		);
		record.parsed = parsed;
	} catch (err) {
		record.response = "";
		record.error = String(err);
		await hooks?.afterFixCall?.(attemptId, record);
		return {
			ok: false,
			record,
			rejectionContext: `Domain-ops generator failed:\n${String(err)}`,
		};
	}
	const response = JSON.stringify(parsed, null, 2);
	const prepared = prepareShapeOpsCandidate({
		response,
		page,
		current: working,
		pass,
		errorPrefix: "Domain-ops generator output",
	});
	if (!prepared.ok) {
		record.error = prepared.error;
		await hooks?.afterFixCall?.(attemptId, record);
		return { ok: false, record, rejectionContext: prepared.rejectionContext };
	}
	await hooks?.afterFixCall?.(attemptId, record);
	return { ok: true, record, prepared };
}

function buildIntentMaterializerTrace(
	pass: ShapeNormalizePass,
	intents: ShapeNormalizeIntent[],
): string {
	return `Intent materializer for accepted shape intents.

pass: ${pass.id}
accepted_intents:
${JSON.stringify(intents, null, 2)}`;
}

const SHAPE_NORMALIZE_DOMAIN = {
	name: "shape-normalize",
	opSchema: `{"ops":[
  {"kind":"set-suggested-canonical","sourcePath":"...","toSuggestedCanonical":"...","reason":"..."},
  {"kind":"clear-suggested-canonical","sourcePath":"...","reason":"..."},
  {"kind":"reshape-object-to-array","sourceObjectPath":"...","sourceMemberPaths":["..."],"toArrayPath":"...","reason":"..."},
  {"kind":"reshape-array-to-dict","sourceArrayPath":"...","keyField":"...","toObjectPath":"...","omitKeyField":true,"reason":"..."},
  {"kind":"reshape-scalar-array-to-dict","sourceArrayPath":"...","toObjectPath":"...","reason":"..."}
]}`,
	extraInstructions: `Generate only the domain op(s) for the single accepted shape intent.
- array-from-object intents become exactly one reshape-object-to-array op.
- array-to-dict intents become exactly one reshape-array-to-dict op.
- scalar-array-to-dict intents become exactly one reshape-scalar-array-to-dict op.
- set-canonical intents become exactly one set-suggested-canonical op.
- clear-canonical intents become exactly one clear-suggested-canonical op.
- Strip a terminal [*] from sourceArrayPath/toObjectPath when the domain op path names the array/container itself.
- Do not generate canonical rename ops for topology intents.
- Do not generate topology reshape ops for canonical rename intents.`,
};

function buildShapeIntentMaterializationText(args: {
	index: number;
	intent: ShapeNormalizeIntent;
	page: PageShapeNormalizeInput;
	pass: ShapeNormalizePass;
	working: ClassifierOutput;
}): string {
	const materialized = materializeShapeNormalizedChrome(
		args.page.chrome,
		args.working.chromePaths,
	);
	return `Accepted shape-normalize intent #${args.index + 1}.

Pass:
${JSON.stringify(
	{
		id: args.pass.id,
		name: args.pass.name,
		objective: args.pass.objective,
	},
	null,
	2,
)}

Intent:
${JSON.stringify(args.intent, null, 2)}

Current materialized chrome:
${JSON.stringify(materialized.chrome, null, 2)}

Source path provenance:
${JSON.stringify(materialized.provenance, null, 2)}`;
}

function makeDomainOpsRunAgent(runAgent: RunAgentFn): GenerateRunAgentFn {
	return ({ prompt, role, attempt, workdir }) =>
		runAgent({
			prompt,
			role: role === "generate" ? "fix" : role,
			attempt,
			workdir,
		});
}

async function requestShapeIntentAttempt(args: {
	attemptId: number;
	page: PageShapeNormalizeInput;
	pass: ShapeNormalizePass;
	working: ClassifierOutput;
	rejectionContext?: string;
	runAgent: RunAgentFn;
	hooks?: ShapeNormalizeAttemptHooks;
	totals: AgentCallTotals;
}): Promise<
	| {
			ok: true;
			record: ShapeNormalizeAttemptRecord;
			intents: ShapeNormalizeIntentOutput;
	  }
	| {
			ok: false;
			record: ShapeNormalizeAttemptRecord;
			rejectionContext: string;
	  }
> {
	const {
		attemptId,
		page,
		pass,
		working,
		rejectionContext,
		runAgent,
		hooks,
		totals,
	} = args;
	const prompt = buildShapeIntentPrompt(page, pass, working, rejectionContext);
	await hooks?.beforeNormalizeCall?.(attemptId, prompt);
	const call = await runAgent({ prompt, role: "classify", attempt: attemptId });
	addTotals(totals, call);
	const normalize: ShapeNormalizeAttemptRecord["normalize"] = {
		prompt,
		response: call.output,
		tokens: metricsOf(call),
	};
	const record: ShapeNormalizeAttemptRecord = {
		attempt: attemptId,
		passId: pass.id,
		passName: pass.name,
		normalize,
	};
	const parsed = parseShapeNormalizeIntentOutput(call.output);
	normalize.parsed = parsed;
	if (!parsed) {
		normalize.error = "unparseable";
		await hooks?.afterNormalizeCall?.(attemptId, normalize);
		return {
			ok: false,
			record,
			rejectionContext:
				'Previous intent output was not valid JSON matching {"intents":[...]}. Return ONLY that JSON object, no prose or code fences.',
		};
	}
	const validation = validateShapeNormalizeIntents(parsed, pass);
	if (!validation.valid) {
		normalize.error = validation.errors.join("; ");
		await hooks?.afterNormalizeCall?.(attemptId, normalize);
		return {
			ok: false,
			record,
			rejectionContext: `Previous intent output failed validation:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
		};
	}
	await hooks?.afterNormalizeCall?.(attemptId, normalize);
	return { ok: true, record, intents: parsed };
}

async function requestIntentDecision(args: {
	attemptId: number;
	page: PageShapeNormalizeInput;
	pass: ShapeNormalizePass;
	working: ClassifierOutput;
	intents: ShapeNormalizeIntentOutput;
	runAgent: RunAgentFn;
	hooks?: ShapeNormalizeAttemptHooks;
	totals: AgentCallTotals;
}): Promise<ReturnType<typeof recordIntentDecisionReview>> {
	const { attemptId, page, pass, working, intents, runAgent, hooks, totals } =
		args;
	const prompt = buildShapeIntentDecisionPrompt(page, pass, working, intents);
	await hooks?.beforeReviewCall?.(attemptId, prompt);
	const call = await runAgent({ prompt, role: "review", attempt: attemptId });
	addTotals(totals, call);
	const result = recordIntentDecisionReview(prompt, call, intents);
	await hooks?.afterReviewCall?.(attemptId, result.record);
	return result;
}

async function reviewShapeNormalizePassCompletion(args: {
	attemptId: number;
	page: PageShapeNormalizeInput;
	pass: ShapeNormalizePass;
	working: ClassifierOutput;
	acceptedPassOps: ShapeNormalizeOp[];
	runAgent: RunAgentFn;
	hooks?: ShapeNormalizeAttemptHooks;
	totals: AgentCallTotals;
}): Promise<{
	record: ReviewAttemptRecord;
	verdict: ReturnType<typeof parseChromeReviewerVerdict>;
}> {
	const {
		attemptId,
		page,
		pass,
		working,
		acceptedPassOps,
		runAgent,
		hooks,
		totals,
	} = args;
	const finalMaterialized = materializeShapeNormalizedChrome(
		page.chrome,
		working.chromePaths,
	);
	const reviewPrompt = buildShapeNormalizeReviewerPrompt(
		page,
		{ ops: acceptedPassOps },
		working,
		finalMaterialized,
		pass,
	);
	await hooks?.beforeReviewCall?.(attemptId, reviewPrompt);
	const reviewCall = await runAgent({
		prompt: reviewPrompt,
		role: "review",
		attempt: attemptId,
	});
	addTotals(totals, reviewCall);
	const verdict = parseChromeReviewerVerdict(reviewCall.output);
	const record: ReviewAttemptRecord = {
		prompt: reviewPrompt,
		response: reviewCall.output,
		tokens: metricsOf(reviewCall),
		verdict: verdict.verdict,
		findings: verdict.findings,
	};
	await hooks?.afterReviewCall?.(attemptId, record);
	return { record, verdict };
}

function recordIntentDecisionReview(
	prompt: string,
	call: {
		output: string;
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cost: number;
	},
	intents: ShapeNormalizeIntentOutput,
):
	| {
			ok: true;
			record: ReviewAttemptRecord;
			decisions: ShapeNormalizeIntentDecisionOutput;
	  }
	| {
			ok: false;
			record: ReviewAttemptRecord;
			rejectionContext: string;
	  } {
	const decisions = parseShapeNormalizeIntentDecisionOutput(call.output);
	if (!decisions) {
		return {
			ok: false,
			record: {
				prompt,
				response: call.output,
				tokens: metricsOf(call),
				verdict: "reject",
				findings: "Decision output was not valid JSON.",
			},
			rejectionContext:
				'Decision output was not valid JSON matching {"decisions":[...]}. Return exactly one decision for every proposed intent.',
		};
	}
	const validation = validateShapeNormalizeIntentDecisions(intents, decisions);
	if (!validation.valid) {
		return {
			ok: false,
			record: {
				prompt,
				response: call.output,
				tokens: metricsOf(call),
				verdict: "reject",
				findings: validation.errors.join("; "),
			},
			rejectionContext: `Decision output failed validation:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
		};
	}
	const hasAccepted = decisions.decisions.some(
		(decision) => decision.decision === "accept",
	);
	return {
		ok: true,
		record: {
			prompt,
			response: call.output,
			tokens: metricsOf(call),
			verdict: hasAccepted ? "pass" : "reject",
			findings: call.output,
		},
		decisions,
	};
}

function addTotals(
	totals: AgentCallTotals,
	call: {
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cost: number;
	},
): void {
	totals.turns += call.turns;
	totals.inputTokens += call.inputTokens;
	totals.outputTokens += call.outputTokens;
	totals.cost += call.cost;
}

function metricsOf(call: {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}): AgentCallTotals {
	return {
		turns: call.turns,
		inputTokens: call.inputTokens,
		outputTokens: call.outputTokens,
		cost: call.cost,
	};
}
