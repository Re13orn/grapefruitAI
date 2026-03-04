# Skill: Test Report Generator

## Goal
Produce a concise, auditable security test report from scenario runs and triage artifacts.

## When To Use
- After one full execution cycle.
- Before sharing findings with developers or QA.
- For regression comparison across versions.

## Required Inputs
- target metadata (`deviceId`, `identifier`, app version if available)
- scenario run results (`list_test_runs` output)
- triage result from `timeline-triage`

## Tooling (MCP)
Primary data sources:
- `list_test_runs`
- `get_history`
- `get_logs`

## Workflow
1. Execution summary
- Report total runs, pass/fail/error counts, and unstable steps.

2. Findings
- Include all `high` and `medium` events.
- Include evidence references and reproducible steps.

3. Recommendations
- Prioritize by exploitability and fix effort.
- Add a concrete re-test checklist.

## Output Contract
Return two artifacts:
1. Markdown report (`report.md`)
2. Machine JSON summary (`report.json`)

`report.json` minimum shape:

```json
{
  "target": {
    "deviceId": "string",
    "identifier": "string"
  },
  "runs": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "errored": 0
  },
  "findings": [
    {
      "id": "string",
      "risk": "high|medium|low",
      "title": "string",
      "status": "open|mitigated|accepted"
    }
  ],
  "nextActions": ["string"]
}
```

## Templates
- `templates/report-template.md`
- `templates/report-template.json`
