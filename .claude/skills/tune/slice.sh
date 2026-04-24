#!/usr/bin/env bash
# Pipeline run slicing helpers for /tune and /tune-step.
# Usage: RUN_ID=<id> .claude/skills/tune/slice.sh <subcommand> [args...]
set -euo pipefail

: "${RUN_ID:?RUN_ID env var required}"

usage() {
  cat >&2 <<EOF
Usage: RUN_ID=<id> $0 <subcommand> [args]

  last-fail <segment>               Last non-passed iteration in a segment.
  reasons   <segment> <phase>       Rejection contexts across iterations of a phase.
  last-steps <segment> <phase>      Per-step status/duration for the phase's last iteration.
  cost                              Cost + tokens grouped by segment.
  iterations <segment>              All iterations (i, phase, status) — compact view.
EOF
  exit 1
}

cmd="${1:-}"; shift || true

case "$cmd" in
  last-fail)
    seg="${1:?segment required}"
    jq '.iterations | map(select(.status != "passed")) | .[-1] | {iteration, phase, status}' \
      "runs/$RUN_ID/$seg/pipeline.json"
    ;;
  reasons)
    seg="${1:?segment required}"; ph="${2:?phase required}"
    jq --arg p "$ph" '.iterations[] | select(.phase==$p) | {i: .iteration, status, reasons: [.steps[].reviews[]?.rejectionContext // empty]}' \
      "runs/$RUN_ID/$seg/pipeline.json"
    ;;
  last-steps)
    seg="${1:?segment required}"; ph="${2:?phase required}"
    jq --arg p "$ph" '.iterations | map(select(.phase==$p)) | .[-1].steps | map({name, type, status, duration, error})' \
      "runs/$RUN_ID/$seg/pipeline.json"
    ;;
  iterations)
    seg="${1:?segment required}"
    jq '.iterations | map({i: .iteration, phase, status})' \
      "runs/$RUN_ID/$seg/pipeline.json"
    ;;
  cost)
    jq -s 'group_by(.segment) | map({seg: .[0].segment, cost: (map(.cost // 0) | add), tokens: (map(.tokens // 0) | add)})' \
      "runs/$RUN_ID/metrics.jsonl"
    ;;
  *)
    usage
    ;;
esac
