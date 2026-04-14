/**
 * Engine barrel export.
 */

export { type DagRunOptions, type DagRunResult, runDag } from "./dag.js";
export {
	type MetricRecord,
	MetricsWriter,
	type RunMetric,
	readMetrics,
	type SegmentMetric,
	type StepMetric,
} from "./metrics.js";
export {
	type PhaseRunOptions,
	type PhaseRunResult,
	runPhase,
} from "./phase-runner.js";
export { resolveProfile } from "./profile.js";
export { registry, SegmentRegistry } from "./registry.js";
export {
	runSegment,
	type SegmentRunOptions,
	type SegmentRunResult,
} from "./segment-runner.js";
export { runCheckCommands, runSelfCheckLoop } from "./self-check.js";
export {
	readPipelineState,
	readRunState,
	writePipelineState,
	writeRunState,
} from "./state.js";
export type {
	CuiConfig,
	IterationState,
	LLMProfile,
	PhaseDef,
	PipelineState,
	Review,
	RunState,
	SegmentDef,
	StepContext,
	StepDef,
	StepFn,
	StepResult,
	StepState,
} from "./types.js";
export { createIteration, createRunDir, createSegmentDir } from "./workdir.js";
