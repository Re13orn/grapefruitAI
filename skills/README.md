# Grapefruit Skills Pack

This folder contains reusable skill definitions for AI agents (Codex, Claude Code, and similar tools).

Each skill provides:
- a fixed goal
- required inputs
- a stable workflow
- output contracts
- ready-to-copy templates

These skills are designed to orchestrate Grapefruit through MCP tools, not replace MCP itself.

## Machine Discovery

- `skills/index.json` is the machine-readable manifest for AI clients.
- Each skill entry includes path, templates, and required MCP tools.
- Validate manifest and file references with:
  - `npm run validate:skills`

## Skills

- `hook-strategy`: Generate and apply hook script plans and startup presets.
- `scenario-dsl`: Build or repair Grapefruit test scenario DSL payloads.
- `timeline-triage`: Analyze captured history/logs and produce security event triage.
- `report-generator`: Produce test reports from scenario runs and triage output.

## Prerequisites

- Grapefruit server is running.
- MCP is enabled (`/api/mcp/status` -> `enabled: true`).
- The AI client can call Grapefruit MCP tools.

## Typical Flow

1. Run `hook-strategy` to define hook coverage and startup behavior.
2. Run `scenario-dsl` to build executable test scenarios.
3. Execute with `run_test_scenario` and collect data.
4. Run `timeline-triage` to classify and prioritize findings.
5. Run `report-generator` for a final report artifact.

## Notes

- Keep generated scripts and scenarios deterministic.
- Prefer structured assertions over free-text checks.
- Store final artifacts (scenario JSON + report markdown) in version control.
