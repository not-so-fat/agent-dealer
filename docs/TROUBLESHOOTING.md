# Troubleshooting

Operator recovery for agent-dealer runtime and host problems. Prefer `agent-dealer doctor` and the **Agents** health strip in the dashboard for live diagnosis; this page holds the longer recovery steps.

## Cursor macOS keychain auth

Long `cursor_local` sessions can die mid-run when macOS keychain refuses to update the Cursor access token (`errSecDuplicateItem`, security exit code 45). agent-dealer preflight treats that output as unhealthy (`cursor_keychain`) so Start / intake can refuse before a wasted run.

### Symptoms

- Agent health / Connections bar: Cursor amber with a keychain remediation message
- `agent-dealer doctor`: Cursor auth failure mentioning keychain
- Mid-session Cursor stderr (also classified when NOT-113 surfaces failure reasons):

```text
Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
```

### Recovery

1. Delete the stuck keychain item:

```bash
security delete-generic-password -s cursor-access-token -a cursor-user
```

2. Sign in again (either form is fine):

```bash
agent login
# or:
cursor-agent login
```

3. Confirm:

```bash
agent-dealer doctor
# Agents page / Connections: Cursor should show ready again
```

If delete reports the item was not found, still run `agent login` / `cursor-agent login` and re-check doctor.

Related: NOT-103 (session death → dirty worktree), NOT-114 (this preflight + docs), NOT-113 (post-failure reason surfacing).
