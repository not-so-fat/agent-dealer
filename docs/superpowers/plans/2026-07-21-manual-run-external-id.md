# Manual run `external_id` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mint `external_id = run.id` on every manual `createRun` so manual tasks carry a stable task key like Linear.

**Architecture:** One-line change in `createRun` when `source` is `manual` and no `externalId` was passed. Retries already copy `externalId` from the parent. Leave `external_label` null.

**Tech Stack:** TypeScript, node:test, better-sqlite3 via existing `createRun` / agent fixtures.

## Global Constraints

- Do not set `external_label` for manual runs.
- Do not change Linear promote (`source: "linear"` with explicit issue id).
- No UI mismatch guard, Slack keys, or data backfill.

---

### Task 1: Mint `external_id` on manual create

**Files:**
- Create: `packages/server/src/repository/runs-external-id.test.ts`
- Modify: `packages/server/src/repository/runs.ts` (`createRun`, `external_id` assignment)

**Interfaces:**
- Consumes: `createRun(input, opts?)` — existing
- Produces: manual run with `externalId === id`, `externalLabel === null`; linear-opts create unchanged

- [ ] **Step 1: Write the failing tests**

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-extid-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("./agents.js");
const { createRun } = await import("./runs.js");

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

test("manual create mints external_id = run.id and leaves external_label null", () => {
  const run = createRun({
    title: "Manual task",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  assert.equal(run.externalId, run.id);
  assert.equal(run.externalLabel, null);
  assert.equal(run.source, "manual");
});

test("manual retry copies parent external_id", () => {
  const parent = createRun({
    title: "Manual task",
    taskCategory: "other",
    status: "review",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  const child = createRun(
    {
      title: parent.title,
      taskCategory: parent.taskCategory,
      status: "plan_approved",
      agentId: BUILTIN_AGENT_CLAUDE_ID,
    },
    {
      source: parent.source,
      externalId: parent.externalId ?? undefined,
      externalLabel: parent.externalLabel ?? undefined,
      lineageId: parent.lineageId ?? parent.id,
    }
  );
  assert.equal(child.externalId, parent.externalId);
  assert.equal(child.externalId, parent.id);
  assert.equal(child.externalLabel, null);
  assert.notEqual(child.id, parent.id);
});

test("explicit linear externalId is not replaced by run.id", () => {
  const issueId = "11111111-1111-4111-8111-111111111111";
  const run = createRun(
    {
      title: "LIN-1: Linear task",
      taskCategory: "code",
      status: "plan_pending",
      agentId: BUILTIN_AGENT_CLAUDE_ID,
    },
    { source: "linear", externalId: issueId, externalLabel: "LIN-1" }
  );
  assert.equal(run.externalId, issueId);
  assert.equal(run.externalLabel, "LIN-1");
  assert.notEqual(run.externalId, run.id);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx tsx --test src/repository/runs-external-id.test.ts`

Expected: FAIL — manual `externalId` is `null`, not `run.id`.

- [ ] **Step 3: Implement mint in `createRun`**

In `packages/server/src/repository/runs.ts`, replace:

```ts
external_id: opts?.externalId ?? null,
```

with:

```ts
source: opts?.source ?? "manual",
// … keep other fields; for external_id:
```

Concretely, compute source first then:

```ts
const source = opts?.source ?? "manual";
const externalId =
  opts?.externalId ?? (source === "manual" ? id : null);
// …
source,
external_id: externalId,
external_label: opts?.externalLabel ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx tsx --test src/repository/runs-external-id.test.ts`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repository/runs.ts packages/server/src/repository/runs-external-id.test.ts docs/superpowers/plans/2026-07-21-manual-run-external-id.md
git commit -m "Mint external_id on manual run create so tasks match Linear identity."
```
