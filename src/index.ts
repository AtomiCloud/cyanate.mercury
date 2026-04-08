/**
 * Mecury — AI Website Regeneration Engine
 *
 * Usage:
 *   bun src/index.ts run                          Run full pipeline
 *   bun src/index.ts run --segment layout          Start from a segment
 *   bun src/index.ts run --from classify           Start from a phase
 *   bun src/index.ts run --dep analyze=runs/X/out  Provide dep outputs
 *   bun src/index.ts resume runs/YYYYMMDD-HHMMSS   Resume a failed run
 *   bun src/index.ts list                          List segments & phases
 */

import { program } from "./cli.js";

// Register segments here as they are implemented:
import "./segments/analyze/index.js";
// import "./segments/build-layout.js";

program.parse();
