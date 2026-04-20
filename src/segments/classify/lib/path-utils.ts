/**
 * Shared helpers for the classify segment.
 *
 * Pared down after the fold-chrome reset — only `classifyUnitHash` is
 * used by the current phases. Dot-path utilities (`readPath`, `setPath`,
 * `deletePath`, `collectAllLeafPaths`) return when per-page chrome
 * classify / harmonize phases land. See `CLASSIFY-PLAN.md`.
 */

import { createHash } from "node:crypto";

/** Deterministic hash for a page URL (used for classify input subdirectories). */
export function classifyUnitHash(url: string): string {
	return createHash("sha1").update(url).digest("hex").slice(0, 12);
}
