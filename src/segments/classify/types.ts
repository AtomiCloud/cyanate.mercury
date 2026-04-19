/**
 * Classify segment — shared data shapes.
 *
 * Stage 1 only needs `ClassifyUnit`. Stages 3–6 will grow this file with the
 * block-level types (`Block`, `Fate`, `Scope`, `Shape`, new
 * `PageClassification`, enum tables, `ValidationResult`) as each phase lands.
 */

import type { PreparedPage } from "../prepare/ingest.js";

export interface ClassifyUnit {
	id: string;
	page: PreparedPage;
}
