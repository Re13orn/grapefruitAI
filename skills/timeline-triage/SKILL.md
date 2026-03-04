# Skill: Timeline Triage

## Goal
Transform raw hook/history/log data into prioritized security events with risk levels, evidence, and remediation hints.

## When To Use
- After running one or more scenarios.
- During regression triage between two builds.
- Before generating a final test report.

## Required Inputs
- `deviceId`
- `identifier`
- optional `timeWindow` or run ID range

## Tooling (MCP)
Use these tools:
1. `get_history` for `hooks`, `crypto`, `nsurl`, `jni`, `privacy`
2. `get_logs` for `syslog`, `agent`
3. optional `list_test_runs` for run context

## Risk Classification Rules
- `high`
  - key/token/plaintext secret exposure
  - crypto misuse indicators (for example deterministic IV patterns)
  - sensitive data sent over cleartext channels
- `medium`
  - sensitive values persisted in weak locations
  - insecure flags or weak defaults
- `low`
  - noisy debug data without immediate exploitability

## Workflow
1. Normalize evidence
- Group records by call, method, URL, key, or component.
- Deduplicate repeated signals.

2. Classify
- Mark each event with `risk`, `category`, and `reason`.
- Keep direct evidence pointers to source records.

3. Recommend
- Provide one concrete mitigation per `high`/`medium` event.

## Output Contract
Return JSON:

```json
{
  "summary": {
    "high": 0,
    "medium": 0,
    "low": 0
  },
  "events": [
    {
      "id": "evt-001",
      "risk": "high",
      "category": "crypto|storage|network|ipc|privacy",
      "title": "string",
      "reason": "string",
      "evidence": [
        {
          "kind": "hooks|crypto|nsurl|jni|privacy|syslog|agent",
          "ref": "string"
        }
      ],
      "recommendation": "string"
    }
  ]
}
```

## Templates
- `templates/triage-output-template.json`
