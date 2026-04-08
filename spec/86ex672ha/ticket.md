# Implement PIPELINE-V3: Three-Segment Fan-in DAG Architecture
- **ID**: 86ex672ha
- **Status**: in progress
- **Priority**: none
- **URL**: https://app.clickup.com/t/86ex672ha

## Description

Summary

Implement the Mecury Pipeline V3 — a three-segment fan-in DAG architecture for AI website regeneration.

analyze ────┐
            ├──→ design
wireframe ──┘

Segments

[table-embed:1:1 Segment| 1:2 Depends On| 1:3 Input| 1:4 Output| 1:5 Purpose| 2:1 analyze | 2:2 —| 2:3 Reference URL + target page types| 2:4 Token JSONs + pattern library| 2:5 Extract the reference site's visual DNA| 3:1 wireframe | 3:2 —| 3:3 Scraper output| 3:4 Working unstyled Astro project| 3:5 Build a structurally correct, CMS-ready site| 4:1 design | 4:2 analyze, wireframe| 4:3 Tokens + patterns + unstyled project| 4:4 Final styled Astro project| 4:5 Apply all visual treatment|]
Key Design Decisions

Analyze and wireframe run concurrently (independent inputs)
Design is the fan-in point — merges both branches
No phase independence violations — wireframe owns structure, design owns presentation
Evidence + review system — autonomous agent reviewers with PASS/REJECT verdicts
Multi-provider LLM strategy — minimax, glm, kimi with consensus for critical steps

Specification

See PIPELINE-V3.md in the repo for the full specification including:

Segment 1 (Analyze): Scout → Extract (visual + measurement) → Merge → Validate
Segment 2 (Wireframe): TBD in spec
Segment 3 (Design): TBD in spec
Evidence + review system architecture
Cost estimates and provider concurrency limits