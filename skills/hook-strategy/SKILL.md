# Skill: Hook Strategy

## Goal
Create a practical hook coverage plan for one target app, then materialize it as Grapefruit hook scripts and a startup preset.

## When To Use
- New target app, unknown behavior.
- You need stable startup-time hooks.
- You want consistent script enable/run-on-launch settings for repeatable tests.

## Required Inputs
- `deviceId`
- `identifier` (bundle/package)
- `platform` (`droid` or `fruity`)
- `focus` (for example: `auth`, `crypto`, `network`, `storage`)

## Tooling (MCP)
Use these tools in this order:
1. `list_hook_scripts`
2. `create_hook_script` or `update_hook_script`
3. `list_hook_script_presets`
4. `create_hook_script_preset`
5. `apply_hook_script_preset`
6. Validation pass: `launch_app`, `wait_for`, `get_history` (`hooks`/`crypto`), `get_logs`

## Workflow
1. Baseline
- Query existing scripts and presets for `(deviceId, identifier)`.
- Reuse existing script IDs when possible.

2. Coverage design
- Include at least one script per high-value data path.
- Mark startup-critical scripts with `runOnAppLaunch: true`.

3. Materialize
- Upsert scripts through MCP.
- Build one preset named with target + focus.
- Apply preset immediately.

4. Validate
- Restart app.
- Confirm expected events appear in `hooks` or `crypto` history.
- If no signal, revise scripts and repeat once.

## Minimum Coverage Heuristic
- Android:
  - crypto (`Cipher.init`, `Cipher.doFinal`)
  - key store (`KeyStore`, `KeyGenParameterSpec`)
  - persistent storage (`SharedPreferences`)
  - app navigation/data handoff (`Intent`)
- iOS:
  - keychain (`SecItem*`)
  - crypto primitives (`CCCrypt`, `SecKey` ops)
  - persistent storage (`NSUserDefaults`)
  - network path (`NSURLSession`)

## Output Contract
Return JSON:

```json
{
  "scripts": [
    {
      "name": "string",
      "enabled": true,
      "runOnAppLaunch": true,
      "action": "created|updated",
      "id": "string"
    }
  ],
  "preset": {
    "id": "string",
    "name": "string",
    "autoApplyOnAppLaunch": true
  },
  "validation": {
    "status": "pass|fail",
    "signals": ["string"],
    "missing": ["string"]
  }
}
```

## Templates
- `templates/hook-plan-template.json`
