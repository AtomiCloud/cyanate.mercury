/**
 * LLM-friendly pipeline watcher.
 *
 * Runs the pipeline with all output suppressed. Polls the active step's
 * files every 15s. If no file activity for 5 minutes → "crashed".
 *
 * Detects activity via:
 * - agent-events.jsonl size changes (new turns/tool calls)
 * - agent-debug.log size changes (API streaming, even between turns)
 * - Any file mtime changes in the step directory
 *
 * Exit codes + single-line stdout:
 *   0  "succeeded"        — pipeline completed
 *   1  "crashed"          — no file activity for 5 min
 *   2  "failed"           — pipeline exited with failure
 *   3  "failed-retry"     — failed after exhausting retries
 *
 * Usage:
 *   bun run llm-watch                  # fresh run
 *   bun run llm-watch --from runs/X    # resume
 */

import { spawn } from "child_process";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { parseArgs } from "util";

const POLL_MS = 15_000;
const STALL_MS = 600_000; // 10 min — some models have long API response times
const RUNS_DIR = join(process.cwd(), "runs");

const { values } = parseArgs({
  options: { from: { type: "string" } },
  strict: false,
});

// ── Helpers ───────────────────────────────────────────────────────────

async function findLatestRunDir(): Promise<string | null> {
  try {
    const entries = await readdir(RUNS_DIR);
    const dirs = entries.filter((e) => /^\d{8}-\d{6}$/.test(e)).sort();
    return dirs.length > 0 ? join(RUNS_DIR, dirs[dirs.length - 1]) : null;
  } catch {
    return null;
  }
}

async function findActiveStep(runDir: string): Promise<string | null> {
  try {
    const entries = await readdir(runDir);
    const stepDirs = entries
      .filter((e) => /^step-\d+-/.test(e))
      .sort((a, b) => {
        const na = parseInt(a.split("-")[1]);
        const nb = parseInt(b.split("-")[1]);
        return nb - na;
      });

    for (const d of stepDirs) {
      try {
        const raw = await readFile(join(runDir, d, "status.json"), "utf-8");
        const s = JSON.parse(raw);
        if (s.status === "running") return join(runDir, d);
      } catch {
        /* no status.json yet — this is the newest step, likely still initializing */
        return join(runDir, d);
      }
    }
  } catch {
    /* run dir gone */
  }
  return null;
}

/** Get a fingerprint of file activity: combined size + mtime of key files + step dir itself */
async function getActivityFingerprint(stepDir: string): Promise<number> {
  let fingerprint = 0;
  // Check step directory mtime (changes during file copy, bun install, etc.)
  try {
    const s = await stat(stepDir);
    fingerprint += Math.floor(s.mtimeMs / 1000);
  } catch { /* */ }
  // Check agent files — agent writes to scratch/ subdirectory
  for (const f of ["agent-events.jsonl", "agent-debug.log"]) {
    for (const dir of [stepDir, join(stepDir, "scratch")]) {
      try {
        const s = await stat(join(dir, f));
        fingerprint += s.size;
        fingerprint += Math.floor(s.mtimeMs / 1000);
      } catch {
        /* file not created yet */
      }
    }
  }
  // status.json is always in stepDir
  try {
    const s = await stat(join(stepDir, "status.json"));
    fingerprint += s.size;
    fingerprint += Math.floor(s.mtimeMs / 1000);
  } catch {
    /* file not created yet */
  }
  // Check scratch/ mtime (changes when agent writes output files)
  try {
    const s = await stat(join(stepDir, "scratch"));
    fingerprint += Math.floor(s.mtimeMs / 1000);
  } catch { /* */ }
  // Check node_modules existence (changes during bun install)
  try {
    const s = await stat(join(stepDir, "node_modules"));
    fingerprint += Math.floor(s.mtimeMs / 1000);
  } catch { /* */ }
  return fingerprint;
}

async function classify(
  runDir: string,
): Promise<{ code: number; label: string }> {
  try {
    const meta = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf-8"),
    );

    if (meta.status === "completed") return { code: 0, label: "succeeded" };

    if (meta.status === "failed") {
      const step = meta.failedStep || "";
      if (
        step.includes("-reviewers") ||
        step.includes("-contract") ||
        step.includes("-runtime")
      ) {
        return { code: 3, label: `failed-retry: ${step}` };
      }
      return { code: 2, label: `failed: ${step || meta.status}` };
    }

    return { code: 2, label: `unknown: ${meta.status}` };
  } catch {
    return { code: 2, label: "failed: no run.json" };
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = ["src/index.ts", "--non-interactive"];
  if (values.from) args.push("--from", values.from);

  const proc = spawn("bun", args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Drain to prevent buffer-full hangs
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", () => {});

  // Wait for run dir to appear
  await new Promise((r) => setTimeout(r, 5000));

  let runDir: string | null = null;
  let lastFingerprint = 0;
  let lastChangeAt = Date.now();

  const stallChecker = setInterval(async () => {
    // Track the newest run dir
    const latest = await findLatestRunDir();
    if (latest) {
      const runId = latest.split("/").pop() ?? "";
      if (!runDir || runId > (runDir.split("/").pop() ?? "")) {
        runDir = latest;
        lastChangeAt = Date.now(); // new run = activity
      }
    }
    if (!runDir) return;

    const active = await findActiveStep(runDir);
    if (!active) {
      // Between steps (runner is working, not an agent) — reset timer
      lastChangeAt = Date.now();
      return;
    }

    const fingerprint = await getActivityFingerprint(active);
    if (fingerprint !== lastFingerprint) {
      // Files changed — agent is alive (tool call, API streaming, etc.)
      lastFingerprint = fingerprint;
      lastChangeAt = Date.now();
    }

    if (Date.now() - lastChangeAt > STALL_MS) {
      proc.kill("SIGKILL");
      clearInterval(stallChecker);
      console.log("crashed");
      process.exit(1);
    }
  }, POLL_MS);

  // Wait for pipeline exit
  const exitCode = await new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });

  clearInterval(stallChecker);
  await new Promise((r) => setTimeout(r, 1000));

  if (!runDir) runDir = await findLatestRunDir();
  if (!runDir) {
    console.log("failed: no run directory found");
    process.exit(2);
  }

  const result = await classify(runDir);
  console.log(result.label);
  process.exit(result.code);
}

main().catch((err) => {
  console.log(`crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
