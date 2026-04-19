/**
 * Ink-based TUI dashboard.
 *
 * Multi-slot: tracks every in-flight step concurrently. Queue depth comes from
 * the global query semaphore. Idle means: no active steps AND no queued work.
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

export type StepStatus = "running" | "completed" | "failed" | "skipped";
export type StepKind = "agent" | "reviewer" | "programmatic";

export interface StepMeta {
	kind?: StepKind;
	parallel?: number;
}

export interface StepView {
	id: string;
	name: string;
	status: StepStatus;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	duration: number;
	startedAt: number;
	error?: string;
	kind?: StepKind;
	parallel?: number;
}

export interface DashboardProps {
	runId?: string;
	completed: StepView[];
	active: StepView[];
	queueDepth: number;
	notes: string[];
	segmentIndex: number;
	segmentTotal: number;
	phaseIndex: number | null;
	phaseTotal: number | null;
	totalCost: number;
	totalSteps: number;
	/** Timestamp (ms) of the most recent transition to fully-idle. */
	idleSince: number | null;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ACTIVE_ROWS = 10;
const MAX_NOTES = 5;
const IDLE_WARN_MS = 10_000;

// --- formatting helpers ---

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function formatCost(usd: number): string {
	if (usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = Math.floor(secs / 60);
	const rem = Math.round(secs % 60);
	return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

// --- hooks ---

function useSpinner(active: boolean): string {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const t = setInterval(
			() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
			200,
		);
		return () => clearInterval(t);
	}, [active]);
	return SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0] ?? "";
}

function useTicker(intervalMs = 1000): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), intervalMs);
		return () => clearInterval(t);
	}, [intervalMs]);
}

// --- status helpers ---

function statusIcon(status: StepStatus, spinner: string): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "skipped":
			return "–";
		case "running":
			return spinner;
	}
}

function statusColor(status: StepStatus): "green" | "red" | "gray" | "yellow" {
	switch (status) {
		case "completed":
			return "green";
		case "failed":
			return "red";
		case "skipped":
			return "gray";
		case "running":
			return "yellow";
	}
}

function kindColor(kind: StepKind | undefined): "cyan" | "magenta" | "gray" {
	switch (kind) {
		case "agent":
			return "cyan";
		case "reviewer":
			return "magenta";
		default:
			return "gray";
	}
}

// Short display name for an active row. Keeps tail (most specific part) over
// head because names are hierarchical (segment/phase/step/leaf/...).
function truncateName(name: string, max: number): string {
	if (name.length <= max) return name;
	return `…${name.slice(name.length - (max - 1))}`;
}

// --- rows ---

function PastRow({ step, index }: { step: StepView; index: number }) {
	const color = statusColor(step.status);
	const icon = statusIcon(step.status, SPINNER_FRAMES[0] ?? "⠋");
	const name = truncateName(step.name, 40);

	const detail =
		step.status === "failed"
			? (step.error ?? "failed")
			: step.status === "skipped"
				? "skipped"
				: `${step.turns}t · ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)} · ${formatCost(step.cost)}`;

	return (
		<Box>
			<Text color={color}>{icon}</Text>
			<Text dimColor>{`  ${String(index + 1).padStart(3, " ")}  `}</Text>
			<Text dimColor={step.status === "skipped"}>{name.padEnd(40, " ")}</Text>
			<Text>{"  "}</Text>
			<Text color={step.status === "failed" ? "red" : undefined}>
				{detail.length > 33
					? `${detail.slice(0, 32)}…`
					: detail.padEnd(33, " ")}
			</Text>
			<Text dimColor>{formatDuration(step.duration)}</Text>
		</Box>
	);
}

function ActiveRow({ step, spinner }: { step: StepView; spinner: string }) {
	const elapsed = Date.now() - step.startedAt;
	const name = truncateName(step.name, 48);
	const metrics = `${step.turns}t · ${formatTokens(step.inputTokens)}/${formatTokens(step.outputTokens)} · ${formatCost(step.cost)}`;
	return (
		<Box>
			<Text color="yellow">{spinner}</Text>
			<Text color={kindColor(step.kind)}>{`  ${name.padEnd(48, " ")}`}</Text>
			<Text dimColor>{`  ${metrics.padEnd(30, " ")}`}</Text>
			<Text dimColor>{`  ${formatDuration(elapsed)}`}</Text>
		</Box>
	);
}

// --- panes ---

function ActivePane({
	active,
	queueDepth,
	lastCompleted,
	idleSince,
	notes,
}: {
	active: StepView[];
	queueDepth: number;
	lastCompleted: StepView | null;
	idleSince: number | null;
	notes: string[];
}) {
	const spinner = useSpinner(active.length > 0);
	useTicker(1000);

	const isIdle = active.length === 0 && queueDepth === 0;

	if (isIdle) {
		const idleMs = idleSince ? Date.now() - idleSince : 0;
		const idleWarn = idleMs > IDLE_WARN_MS;
		return (
			<Box flexDirection="column" paddingY={1}>
				<Box>
					<Text color={idleWarn ? "yellow" : "gray"}>
						{idleWarn ? "!" : "·"}
					</Text>
					<Text bold>{"  idle"}</Text>
					<Text dimColor>{`  (${formatDuration(idleMs)} between steps)`}</Text>
				</Box>
				{lastCompleted ? (
					<Box marginTop={1}>
						<Text dimColor>{`    last: ${lastCompleted.name}`}</Text>
					</Box>
				) : null}
				{idleWarn ? (
					<Box marginTop={1}>
						<Text color="yellow">
							{"    idle > 10s — check stderr for errors"}
						</Text>
					</Box>
				) : null}
				<NotesBlock notes={notes} />
			</Box>
		);
	}

	const rows = active.slice(0, MAX_ACTIVE_ROWS);
	const hiddenActive = active.length - rows.length;

	const totalIn = active.reduce((s, a) => s + a.inputTokens, 0);
	const totalOut = active.reduce((s, a) => s + a.outputTokens, 0);
	const totalCost = active.reduce((s, a) => s + a.cost, 0);

	return (
		<Box flexDirection="column" paddingY={1}>
			<Box>
				<Text bold>{`  in-flight `}</Text>
				<Text color="yellow">{String(active.length)}</Text>
				<Text dimColor>{"   queued "}</Text>
				<Text color={queueDepth > 0 ? "cyan" : "gray"}>
					{String(queueDepth)}
				</Text>
				<Text dimColor>{"   tokens "}</Text>
				<Text>{`${formatTokens(totalIn)} in · ${formatTokens(totalOut)} out`}</Text>
				<Text dimColor>{"   cost "}</Text>
				<Text>{formatCost(totalCost)}</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{rows.map((step) => (
					<ActiveRow key={step.id} step={step} spinner={spinner} />
				))}
				{hiddenActive > 0 ? (
					<Box>
						<Text dimColor>{`    … ${hiddenActive} more`}</Text>
					</Box>
				) : null}
			</Box>
			<NotesBlock notes={notes} />
		</Box>
	);
}

function NotesBlock({ notes }: { notes: string[] }) {
	if (notes.length === 0) return null;
	const recent = notes.slice(-MAX_NOTES);
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text dimColor>{"    notes"}</Text>
			{recent.map((n, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only and duplicates are meaningful
				<Box key={i}>
					<Text dimColor>{`      · ${n}`}</Text>
				</Box>
			))}
		</Box>
	);
}

function PastPane({ completed }: { completed: StepView[] }) {
	const MAX = 15;
	const recent = completed.slice(-MAX);
	const hiddenCount = completed.length - recent.length;

	if (completed.length === 0) {
		return (
			<Box flexDirection="column" paddingY={1}>
				<Text dimColor> (no completed steps yet)</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" paddingY={1}>
			{hiddenCount > 0 ? (
				<Box>
					<Text
						dimColor
					>{`  … showing last ${recent.length} of ${completed.length} completed steps`}</Text>
				</Box>
			) : null}
			{recent.map((step, i) => {
				const absoluteIndex = completed.length - recent.length + i;
				return <PastRow key={step.id} step={step} index={absoluteIndex} />;
			})}
		</Box>
	);
}

// --- status bar ---

function StatusBar({
	totalCost,
	totalSteps,
	segmentIndex,
	segmentTotal,
	phaseIndex,
	phaseTotal,
}: {
	totalCost: number;
	totalSteps: number;
	segmentIndex: number;
	segmentTotal: number;
	phaseIndex: number | null;
	phaseTotal: number | null;
}) {
	const cost = formatCost(totalCost);
	const steps = `${totalSteps} step${totalSteps === 1 ? "" : "s"}`;
	const seg =
		segmentIndex === 0
			? `seg 0/${segmentTotal}`
			: `seg ${segmentIndex}/${segmentTotal}`;
	const phase =
		phaseIndex === null
			? "phase ?/?"
			: `phase ${phaseIndex}/${phaseTotal ?? "?"}`;

	return (
		<Box>
			<Text bold>{` ${cost} `}</Text>
			<Text dimColor>{" · "}</Text>
			<Text>{steps}</Text>
			<Text dimColor>{" · "}</Text>
			<Text>{seg}</Text>
			<Text dimColor>{" · "}</Text>
			<Text>{phase}</Text>
		</Box>
	);
}

// --- tab bar ---

type Tab = "past" | "active";

function TabBar({
	active,
	completedCount,
	activeCount,
}: {
	active: Tab;
	completedCount: number;
	activeCount: number;
}) {
	const pastLabel = `[1] Past (${completedCount})`;
	const activeLabel = `[2] Active (${activeCount})`;
	return (
		<Box>
			<Text bold={active === "past"} inverse={active === "past"}>
				{` ${pastLabel} `}
			</Text>
			<Text> </Text>
			<Text bold={active === "active"} inverse={active === "active"}>
				{` ${activeLabel} `}
			</Text>
			<Text dimColor>{"   (Tab to switch)"}</Text>
		</Box>
	);
}

// --- dashboard ---

export function Dashboard(props: DashboardProps) {
	const {
		runId,
		completed,
		active,
		queueDepth,
		notes,
		segmentIndex,
		segmentTotal,
		phaseIndex,
		phaseTotal,
		totalCost,
		totalSteps,
		idleSince,
	} = props;

	const lastCompleted =
		completed.length > 0 ? (completed[completed.length - 1] ?? null) : null;

	const [tab, setTab] = useState<Tab>("active");

	useInput((input, key) => {
		if (key.tab) {
			setTab((t) => (t === "past" ? "active" : "past"));
			return;
		}
		if (input === "1") setTab("past");
		if (input === "2") setTab("active");
	});

	return (
		<Box flexDirection="column">
			{runId ? (
				<Box>
					<Text bold dimColor>{`  mecury ${runId}`}</Text>
				</Box>
			) : null}
			<Box marginTop={1}>
				<TabBar
					active={tab}
					completedCount={completed.length}
					activeCount={active.length}
				/>
			</Box>
			<Box>
				<Text dimColor>
					{"────────────────────────────────────────────────────────────────"}
				</Text>
			</Box>
			{tab === "active" ? (
				<ActivePane
					active={active}
					queueDepth={queueDepth}
					lastCompleted={lastCompleted}
					idleSince={idleSince}
					notes={notes}
				/>
			) : (
				<PastPane completed={completed} />
			)}
			<Box>
				<Text dimColor>
					{"────────────────────────────────────────────────────────────────"}
				</Text>
			</Box>
			<StatusBar
				totalCost={totalCost}
				totalSteps={totalSteps}
				segmentIndex={segmentIndex}
				segmentTotal={segmentTotal}
				phaseIndex={phaseIndex}
				phaseTotal={phaseTotal}
			/>
		</Box>
	);
}
