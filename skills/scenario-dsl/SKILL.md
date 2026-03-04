# Skill: Scenario DSL Builder

## Goal
Generate or repair Grapefruit scenario DSL payloads that can be created and executed without schema errors.

## When To Use
- You need repeatable, machine-checkable test flows.
- Existing scenario JSON is invalid or flaky.
- You want stronger assertions with less manual editing.

## Required Inputs
- `deviceId`
- `identifier`
- `scenarioGoal` (short text)
- optional `platform`, `mode`, `bundle` for run target

## Tooling (MCP)
Use these tools:
1. `create_test_scenario`
2. `update_test_scenario`
3. `run_test_scenario`
4. `list_test_runs`
5. `get_history`
6. `get_logs`

## DSL Step Types
- `note`
- `sleep`
- `clear_history`
- `clear_logs`
- `agent_rpc`
- `assert`

## Assertion Types
- `history_count`
- `history_contains`
- `log_contains`
- `saved_value`

## Workflow
1. Build a minimal deterministic flow
- Start with cleanup steps (`clear_history`, `clear_logs`).
- Add only required `agent_rpc` calls.
- Add assertions with explicit expected values.

2. Validate executable quality
- Run scenario with `stopOnFailure: true`.
- If failed by missing data, add `sleep` or relax overly strict assertion.
- Re-run and keep only stable assertions.

3. Finalize
- Ensure each step has clear purpose.
- Ensure at least one assertion checks security-relevant behavior.

## Output Contract
Return JSON:

```json
{
  "scenario": {
    "name": "string",
    "description": "string",
    "tags": ["string"],
    "steps": []
  },
  "runConfig": {
    "stopOnFailure": true,
    "target": {
      "platform": "droid",
      "mode": "app",
      "bundle": "com.example.app"
    }
  },
  "stabilityNotes": ["string"]
}
```

## Templates
- `templates/scenario-template.json`
