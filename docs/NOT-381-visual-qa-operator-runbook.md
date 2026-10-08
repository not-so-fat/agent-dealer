# NOT-381 operator runbook: browser-capable developer visual QA

Proves the `[operator]` acceptance criterion: a real Dealer Claude Code
developer session on a UI change runs the real backend and frontend without
mocks, captures the affected path at `1440x900` and `390x800`, and the
persisted receipt names the exact PR head and both artifacts.

Run on a host where the Claude Code runtime can launch headless Chromium and
serve the app on loopback (NOT the Muse sandbox — Chrome.app aborts there by
design, see `docs/evaluations/muse-code/chrome-headless-screenshot.md`).

## 1. Create a UI-change issue with a Claude Code developer

```bash
agent-dealer issue create \
  --title "NOT-381 probe: <visible UI change>" \
  --repo github.com/<org>/<repo> \
  --developer-agent <claude-code-agent-id> \
  --reviewer-agent <reviewer-agent-id> \
  --description "<what to change and where>" \
  --acceptance-criteria "- [ ] [agent] <UI-visible criterion naming the affected path>"
```

Record the returned issue id as `<issueId>`.

## 2. Start it and wait for review

```bash
agent-dealer issue start <issueId>
agent-dealer issue show <issueId>   # poll .issue.status until reviewing/verifying
```

## 3. Collect the evidence

```bash
agent-dealer issue show <issueId> --include evidence
```

From the output (plus `gh pr view <prNumber> --json headRefOid` for the
independent PR-head check) record:

- Dealer issue id and the developer run/session id
- PR head SHA (`issue.headSha`, must equal the `gh` head)
- the `visual_qa_receipt` artifact: `status: verified`,
  `headSha` equal to the PR head SHA above
- the two screenshot blob references (`desktop-1440x900.png`,
  `mobile-390x800.png`), their viewport sizes, and the receipt's
  `commands` + `scenario` lines proving the real app ran without mocks

## 4. Pass / fail

- PASS: receipt status is `verified`, its `headSha` equals the PR head, both
  blobs exist, and the commands show the real backend/frontend (no mocks
  unless the criterion permits them).
- FAIL (still record everything): receipt missing, status `unavailable`
  (record the named failed capability instead), `visual_qa_rejected`
  present (record its reason), or any SHA/blob mismatch.
