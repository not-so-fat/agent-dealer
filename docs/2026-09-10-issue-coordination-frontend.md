# Issue Coordination — Frontend Implementation Plan

**Goal:** Replace the run-oriented nav (Operations/Inbox/Done/Agents) with the issue-centric nav (Issues/Human actions/Agents), per PRD §7: an issues list, an issue detail view (header + timeline + composer + intent-forecast rail), and a global human-action queue.

**Depends on:** Plans 1–3 (data model, coordinator, API/CLI) — all complete. This plan is pure frontend, consuming the `/api/issues*` and `/api/human-actions*` routes Plan 3 shipped.

**Spec:** `docs/2026-09-10-issue-centric-coordination-design.md` (Frontend section, PRD §7)

**Tech Stack:** React + TypeScript + Tailwind (v4 CSS-based `@theme`), Vite. **No test runner exists for `apps/web`** (no vitest/jest/RTL configured) — this is a fact about the repo, not a gap this plan introduces. Verification is `tsc -b --noEmit` (the existing `npm run build` gate) plus a manual dev-server walkthrough at the end, matching the spec's own Testing section: *"UI: no new automated UI tests required beyond what exists; manual walkthrough of the five-second-state test (PRD §12) before PR."* Tasks in this plan therefore replace the TDD red/green cycle with a typecheck-and-visually-verify cycle — this is a deliberate difference from Plans 1–3, not a shortcut.

## Global Constraints

- No new UI framework, router, or state-management library — the app already does state-based view switching in `App.tsx` (`useState<View>`) with no `react-router`; this plan keeps that pattern rather than introducing one.
- Reuse the existing Tailwind theme tokens from `apps/web/src/index.css`'s `@theme` block (`cyber-gold`, `cyber-teal`, `cyber-violet`, `cyber-violet-light`, `panel`, `panel-elevated`, `text-muted`) rather than inventing a new palette.
- Data types come directly from `@agent-dealer/shared` (`Issue`, `WorkerSession`, `WorkflowEvent`, `HumanAction`, `Finding`, `IssueStatus`) — no duplicate frontend-only type definitions.
- **Scoping decision, stated not hidden:** "New issue" creation in this plan covers manual creation only. Linear import already works end-to-end via the CLI (`agent-dealer issue import`, Plan 3) — a UI picker reusing `IntakePage`'s Linear-candidate-listing components is real additional work not included here, and is called out in the self-review as a deliberate deferral, not a silent gap.
- **Scoping decision on old pages:** `App.tsx` stops importing/rendering `OperationsPage`/`IntakePage`/`DonePage` (satisfying "replace the nav"), but this plan does not delete those component files or their exclusively-used children (`RunDrawer`, `RunCard`, `components/ops/*`) — they become orphaned dead code. Deleting them safely requires confirming nothing else references them, which is real, separate work; flagged in the self-review as a deliberate deferral.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/api.ts` (modify) | Add `fetchIssues`, `fetchIssueDetail`, `fetchIssueEvidence`, `createIssue`, `startIssue`, `guideIssue`, `fetchHumanActions`, `resolveHumanAction` |
| `apps/web/src/pages/IssuesListPage.tsx` (new) | PRD §7.2 row list + "New issue" manual-create form |
| `apps/web/src/pages/IssueDetailPage.tsx` (new) | PRD §7.3–7.5: header, timeline, composer, intent-forecast rail |
| `apps/web/src/components/issues/IssueStatusBadge.tsx` (new) | Shared status→color/label mapping used by both pages |
| `apps/web/src/components/issues/IssueTimeline.tsx` (new) | Renders `WorkflowEvent[]` as PRD §7.4's artifact-first rows |
| `apps/web/src/pages/HumanActionsPage.tsx` (new) | PRD §7.6: global queue with resolve controls |
| `apps/web/src/App.tsx` (modify) | Replace Operations/Inbox/Done nav with Issues/Human actions/Agents |

---

### Task 1: API client additions

**Files:**
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Produces: `fetchIssues(status?: IssueStatus[]): Promise<IssueListRow[]>`, `fetchIssueDetail(id: string): Promise<IssueDetail>`, `fetchIssueEvidence(id: string): Promise<IssueEvidence>`, `createIssue(input: CreateIssueInput): Promise<Issue>`, `startIssue(id: string): Promise<Issue>`, `guideIssue(id: string, markdown: string): Promise<WorkflowEvent>`, `fetchHumanActions(): Promise<HumanAction[]>`, `resolveHumanAction(id: string, choice: string, resolvedBy: string): Promise<HumanAction>`

No test file — this task is a typecheck-only change (see plan-level Tech Stack note). Verify by running the typecheck command in Step 2.

- [ ] **Step 1: Add the functions**

Append to `apps/web/src/api.ts` (after the existing `fetchLinearConfig` function, or any convenient spot near the other `fetch*` functions):

```typescript
import type {
  CreateIssueInput,
  Finding,
  HumanAction,
  Issue,
  IssueStatus,
  UsageEvent,
  WorkerSession,
  WorkflowEvent,
} from "@agent-dealer/shared";

export interface IssueListRow {
  id: string;
  title: string;
  status: IssueStatus;
  currentOwner: string;
  currentIntent: string | null;
  updatedAt: string;
  hasOpenHumanAction: boolean;
}

export interface IssueDetail {
  issue: Issue;
  timeline: WorkflowEvent[];
  forecast: { now: string; next: string };
  humanActions: HumanAction[];
  findings: Finding[];
  usageSummary: { totalCostUsd: number; totalDurationMs: number; totalTokensIn: number; totalTokensOut: number };
}

export interface IssueEvidence {
  workerSessions: WorkerSession[];
  artifacts: Array<{ id: string; kind: string; contentJson: string | null; createdAt: string }>;
  usageEvents: UsageEvent[];
}

export async function fetchIssues(status?: IssueStatus[]): Promise<IssueListRow[]> {
  const qs = status?.length ? `?status=${status.join(",")}` : "";
  const res = await fetch(`${API}/api/issues${qs}`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchIssueDetail(id: string): Promise<IssueDetail> {
  const res = await fetch(`${API}/api/issues/${id}`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchIssueEvidence(id: string): Promise<IssueEvidence> {
  const res = await fetch(`${API}/api/issues/${id}/evidence`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function createIssue(input: CreateIssueInput): Promise<Issue> {
  const res = await fetch(`${API}/api/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function startIssue(id: string): Promise<Issue> {
  const res = await fetch(`${API}/api/issues/${id}/start`, { method: "POST" });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function guideIssue(id: string, markdown: string): Promise<WorkflowEvent> {
  const res = await fetch(`${API}/api/issues/${id}/guidance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchHumanActions(): Promise<HumanAction[]> {
  const res = await fetch(`${API}/api/human-actions`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function resolveHumanAction(id: string, choice: string, resolvedBy: string): Promise<HumanAction> {
  const res = await fetch(`${API}/api/human-actions/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice, resolvedBy }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}
```

Add the new `import type { ... } from "@agent-dealer/shared"` names to the **existing** top-of-file import block rather than creating a second `import type` statement from the same module — TypeScript allows it but ESLint/import-order conventions in this repo keep one block per module (check the existing import list at the top of `api.ts` before adding a duplicate).

- [ ] **Step 2: Verify — typecheck**

Run: `npm run typecheck -w @agent-dealer/web`
Expected: PASS, no errors. If it fails because `@agent-dealer/shared` doesn't yet export something used here, rebuild shared first with `npm run build -w @agent-dealer/shared` and retry — it should already export everything needed since Plan 1 is complete.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api.ts
git commit -m "Add frontend API client functions for issues and human actions (NOT-57)"
```

---

### Task 2: `IssueStatusBadge` + `IssuesListPage`

**Files:**
- Create: `apps/web/src/components/issues/IssueStatusBadge.tsx`
- Create: `apps/web/src/pages/IssuesListPage.tsx`

**Interfaces:**
- Consumes: `fetchIssues`, `createIssue` (Task 1); `IssueStatus`, `CreateIssueInput`, `AgentWithHealth` (`@agent-dealer/shared`)
- Produces: `export default function IssueStatusBadge({ status }: { status: IssueStatus })`; `export default function IssuesListPage({ agents, onSelectIssue }: Props)`

- [ ] **Step 1: Write the components**

```typescript
// apps/web/src/components/issues/IssueStatusBadge.tsx
import type { IssueStatus } from "@agent-dealer/shared";

const STYLES: Record<IssueStatus, string> = {
  ready: "bg-white/10 text-white/70 border-white/20",
  developing: "bg-cyber-violet/20 text-cyber-violet-light border-cyber-violet/40",
  reviewing: "bg-cyber-gold/20 text-[#E8DC7A] border-cyber-gold/40",
  repairing: "bg-cyber-violet/25 text-cyber-violet-light border-cyber-violet/50",
  final_review: "bg-amber-500/20 text-amber-300 border-amber-400/40",
  needs_human: "bg-red-500/20 text-red-300 border-red-400/40",
  done: "bg-cyber-teal/20 text-cyber-teal border-cyber-teal/40",
  closed: "bg-white/5 text-white/40 border-white/10",
};

const LABELS: Record<IssueStatus, string> = {
  ready: "Ready",
  developing: "Developing",
  reviewing: "Reviewing",
  repairing: "Repairing",
  final_review: "Final review",
  needs_human: "Needs human",
  done: "Done",
  closed: "Closed",
};

export default function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span className={`text-xs leading-none px-2 py-1 rounded border tabular-nums ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  );
}
```

```typescript
// apps/web/src/pages/IssuesListPage.tsx
import { useEffect, useState } from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
import { createIssue, fetchIssues, type IssueListRow } from "../api";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import AlertIcon from "../components/ui/AlertIcon";

type Props = {
  agents: AgentWithHealth[];
  onSelectIssue: (id: string) => void;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function IssuesListPage({ agents, onSelectIssue }: Props) {
  const [issues, setIssues] = useState<IssueListRow[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [developerAgentId, setDeveloperAgentId] = useState("");
  const [reviewerAgentId, setReviewerAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => fetchIssues().then(setIssues).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, []);

  const submitCreate = async () => {
    if (!title.trim() || !repo.trim() || !developerAgentId || !reviewerAgentId) {
      setError("Title, repo, developer, and reviewer are required");
      return;
    }
    try {
      await createIssue({ title, repo, developerAgentId, reviewerAgentId, baseBranch: "main", maxReviewRounds: 3, source: "manual" });
      setShowCreate(false);
      setTitle("");
      setRepo("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white/90">Issues</h2>
        <button type="button" className="btn-primary px-4" onClick={() => setShowCreate((v) => !v)}>
          New issue
        </button>
      </div>

      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}

      {showCreate && (
        <div className="mb-4 p-4 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
          <input className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Repo path" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <select className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" value={developerAgentId} onChange={(e) => setDeveloperAgentId(e.target.value)}>
            <option value="">Developer agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <select className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" value={reviewerAgentId} onChange={(e) => setReviewerAgentId(e.target.value)}>
            <option value="">Reviewer agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button type="button" className="btn-primary px-4" onClick={submitCreate}>Create</button>
            <button type="button" className="px-4 py-2 text-sm text-white/60 hover:text-white" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      {issues === null ? (
        <p className="text-white/50 text-sm">Loading…</p>
      ) : issues.length === 0 ? (
        <p className="text-white/45 text-sm">No issues yet — create one to get started.</p>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => onSelectIssue(issue.id)}
              className="w-full text-left flex items-center gap-3 px-4 py-3 rounded border border-white/10 bg-panel-elevated/40 hover:bg-panel-elevated/70 transition-colors"
            >
              {issue.hasOpenHumanAction && <AlertIcon className="w-4 h-4 shrink-0 text-red-400" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white/90 truncate">{issue.title}</p>
                {issue.currentIntent && <p className="text-xs text-white/50 truncate">{issue.currentIntent}</p>}
              </div>
              <span className="text-xs text-white/40 capitalize shrink-0">{issue.currentOwner}</span>
              <IssueStatusBadge status={issue.status} />
              <span className="text-xs text-white/35 shrink-0 w-16 text-right">{timeAgo(issue.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify — typecheck**

Run: `npm run typecheck -w @agent-dealer/web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/issues/IssueStatusBadge.tsx apps/web/src/pages/IssuesListPage.tsx
git commit -m "Add IssueStatusBadge and IssuesListPage (NOT-57)"
```

---

### Task 3: `IssueTimeline` + `IssueDetailPage`

**Files:**
- Create: `apps/web/src/components/issues/IssueTimeline.tsx`
- Create: `apps/web/src/pages/IssueDetailPage.tsx`

**Interfaces:**
- Consumes: `fetchIssueDetail`, `guideIssue`, `startIssue` (Task 1); `WorkflowEvent`, `WorkflowEventType` (`@agent-dealer/shared`)
- Produces: `export default function IssueTimeline({ events }: { events: WorkflowEvent[] })`; `export default function IssueDetailPage({ issueId, onBack }: Props)`

- [ ] **Step 1: Write the components**

```typescript
// apps/web/src/components/issues/IssueTimeline.tsx
import type { WorkflowEvent } from "@agent-dealer/shared";

const LABELS: Record<string, (e: WorkflowEvent) => string> = {
  "issue.created": () => "Issue created",
  "workflow.started": () => "Workflow started",
  "worker.started": (e) => `${e.actorType === "developer" ? "Developer" : e.actorType === "reviewer" ? "Reviewer" : "Worker"} started${e.round ? ` (round ${e.round})` : ""}`,
  "worker.completed": (e) => `${e.actorType === "developer" ? "Developer" : e.actorType === "reviewer" ? "Reviewer" : "Worker"} finished${e.round ? ` (round ${e.round})` : ""}`,
  "worker.failed": () => "Worker failed",
  "pull_request.opened": () => "Developer opened the PR",
  "pull_request.updated": () => "Developer updated the PR",
  "checks.completed": () => "Checks completed",
  "review.submitted": () => "Reviewer submitted a review",
  "repair.started": (e) => `Repair round ${e.round ?? "?"} started`,
  "guidance.added": () => "Guidance added",
  "human_action.requested": () => "Human action requested",
  "human_action.resolved": () => "Human action resolved",
  "final_review.requested": () => "Final review requested",
  "issue.completed": () => "Issue completed",
  "issue.closed": () => "Issue closed",
};

function describe(e: WorkflowEvent): string {
  return LABELS[e.type]?.(e) ?? e.type;
}

export default function IssueTimeline({ events }: { events: WorkflowEvent[] }) {
  if (events.length === 0) return <p className="text-white/40 text-sm">No activity yet.</p>;
  return (
    <div className="space-y-1">
      {events.map((e) => (
        <div key={e.id} className="flex items-baseline gap-3 py-1.5 border-b border-white/5 last:border-0">
          <span className="text-xs text-white/35 w-20 shrink-0 tabular-nums">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="text-sm text-white/80">{describe(e)}</span>
          {e.type === "guidance.added" && e.payloadJson && (
            <span className="text-sm text-white/55 italic">
              — {(JSON.parse(e.payloadJson) as { markdown?: string }).markdown}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

```typescript
// apps/web/src/pages/IssueDetailPage.tsx
import { useEffect, useState } from "react";
import { fetchIssueDetail, guideIssue, startIssue, type IssueDetail } from "../api";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import IssueTimeline from "../components/issues/IssueTimeline";

type Props = {
  issueId: string;
  onBack: () => void;
};

export default function IssueDetailPage({ issueId, onBack }: Props) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => fetchIssueDetail(issueId).then(setDetail).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 4000);
    return () => clearInterval(poll);
  }, [issueId]);

  if (error) return <div className="p-6 text-red-300 text-sm">{error}</div>;
  if (!detail) return <div className="p-6 text-white/50 text-sm">Loading…</div>;

  const { issue, timeline, forecast, humanActions, usageSummary } = detail;
  const durationMs = Date.now() - new Date(issue.createdAt).getTime();
  const durationMin = Math.floor(durationMs / 60_000);

  const submitGuidance = async () => {
    if (!guidance.trim()) return;
    await guideIssue(issueId, guidance);
    setGuidance("");
    refresh();
  };

  const handleStart = async () => {
    await startIssue(issueId);
    refresh();
  };

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
        <button type="button" onClick={onBack} className="text-sm text-white/50 hover:text-white mb-3">
          ← Issues
        </button>

        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90">{issue.title}</h2>
            <p className="text-xs text-white/45 mt-1">
              Owner: <span className="capitalize">{issue.currentOwner}</span>
              {issue.currentIntent ? ` · ${issue.currentIntent}` : ""}
            </p>
            <div className="flex gap-3 mt-2 text-xs text-white/40">
              {issue.prUrl && <a href={issue.prUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">PR #{issue.prNumber}</a>}
              {issue.externalUrl && <a href={issue.externalUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">{issue.externalLabel ?? "External link"}</a>}
              <span>Round {issue.currentRound}/{issue.maxReviewRounds}</span>
              <span>{durationMin}m elapsed</span>
              <span>${usageSummary.totalCostUsd.toFixed(2)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <IssueStatusBadge status={issue.status} />
            {issue.status === "ready" && (
              <button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={handleStart}>Start</button>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 pt-3">
          <IssueTimeline events={timeline} />
        </div>

        <div className="mt-4 flex gap-2">
          <input
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            placeholder="Guide this issue…"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGuidance()}
          />
          <button type="button" className="btn-primary px-4" onClick={submitGuidance}>Send</button>
        </div>
      </div>

      <aside className="w-72 shrink-0 border-l border-white/10 px-4 py-4 overflow-y-auto">
        <h3 className="text-xs uppercase tracking-wide text-white/40 mb-2">Intent forecast</h3>
        <p className="text-sm text-white/85 mb-1">Now: {forecast.now}</p>
        {forecast.next && <p className="text-sm text-white/55">Next: {forecast.next}</p>}

        {humanActions.filter((a) => a.status === "open").length > 0 && (
          <div className="mt-4 p-3 rounded border border-red-400/30 bg-red-500/10">
            <p className="text-xs text-red-300 font-medium">Human action needed</p>
            {humanActions.filter((a) => a.status === "open").map((a) => (
              <p key={a.id} className="text-sm text-white/80 mt-1">{a.question}</p>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
```

- [ ] **Step 2: Verify — typecheck**

Run: `npm run typecheck -w @agent-dealer/web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/issues/IssueTimeline.tsx apps/web/src/pages/IssueDetailPage.tsx
git commit -m "Add IssueTimeline and IssueDetailPage (NOT-57)"
```

---

### Task 4: `HumanActionsPage`

**Files:**
- Create: `apps/web/src/pages/HumanActionsPage.tsx`

**Interfaces:**
- Consumes: `fetchHumanActions`, `resolveHumanAction` (Task 1); `HumanAction`, `HumanActionType` (`@agent-dealer/shared`)
- Produces: `export default function HumanActionsPage({ onSelectIssue }: Props)`

Per-`actionType` choice buttons mirror `resolveHumanActionOutcome`'s accepted `choice` values exactly (Plan 3 Task 2) — `final_review`: complete/repair/close; `attempts_exhausted`: retry/close; `policy_escalation`: resume/close; `product_scope_decision`: resume.

- [ ] **Step 1: Write the component**

```typescript
// apps/web/src/pages/HumanActionsPage.tsx
import { useEffect, useState } from "react";
import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { fetchHumanActions, resolveHumanAction } from "../api";

type Props = {
  onSelectIssue: (id: string) => void;
};

const CHOICES: Record<HumanActionType, Array<{ value: string; label: string }>> = {
  final_review: [
    { value: "complete", label: "Complete" },
    { value: "repair", label: "Another round" },
    { value: "close", label: "Close without accepting" },
  ],
  attempts_exhausted: [
    { value: "retry", label: "Allow another round" },
    { value: "close", label: "Close" },
  ],
  policy_escalation: [
    { value: "resume", label: "Resume" },
    { value: "close", label: "Close" },
  ],
  product_scope_decision: [{ value: "resume", label: "Resume with this decision" }],
};

const TYPE_LABELS: Record<HumanActionType, string> = {
  final_review: "Final review",
  attempts_exhausted: "Attempts exhausted",
  policy_escalation: "Policy escalation",
  product_scope_decision: "Product scope decision",
};

export default function HumanActionsPage({ onSelectIssue }: Props) {
  const [actions, setActions] = useState<HumanAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => fetchHumanActions().then(setActions).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, []);

  const resolve = async (id: string, choice: string) => {
    try {
      await resolveHumanAction(id, choice, "human");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <h2 className="text-lg font-semibold text-white/90 mb-4">Human actions</h2>
      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}

      {actions === null ? (
        <p className="text-white/50 text-sm">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="text-white/45 text-sm">Nothing needs your attention.</p>
      ) : (
        <div className="space-y-3">
          {actions.map((action) => (
            <div key={action.id} className="p-4 rounded border border-red-400/25 bg-panel-elevated/50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs uppercase tracking-wide text-red-300/80">{TYPE_LABELS[action.actionType]}</span>
                <button type="button" className="text-xs text-cyber-teal hover:underline" onClick={() => onSelectIssue(action.issueId)}>
                  View issue
                </button>
              </div>
              <p className="text-sm text-white/85 mb-1">{action.reason}</p>
              <p className="text-sm text-white/60 mb-3">{action.question}</p>
              <div className="flex gap-2">
                {CHOICES[action.actionType].map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className="btn-primary px-3 py-1.5 text-sm"
                    onClick={() => resolve(action.id, choice.value)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify — typecheck**

Run: `npm run typecheck -w @agent-dealer/web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/HumanActionsPage.tsx
git commit -m "Add HumanActionsPage (NOT-57)"
```

---

### Task 5: Replace the nav in `App.tsx`

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `IssuesListPage`, `IssueDetailPage`, `HumanActionsPage` (Tasks 2–4); `fetchHumanActions` (Task 1, for the nav badge count); `AgentsPage` (existing, unchanged)

This task removes `OperationsPage`/`IntakePage`/`DonePage`/`RunDrawer` usage from `App.tsx` (they remain as orphaned files per the plan's stated scoping decision) and replaces the `View` type and nav bar.

- [ ] **Step 1: Rewrite `App.tsx`**

```typescript
// apps/web/src/App.tsx
import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
import AgentsPage from "./pages/AgentsPage";
import IssuesListPage from "./pages/IssuesListPage";
import IssueDetailPage from "./pages/IssueDetailPage";
import HumanActionsPage from "./pages/HumanActionsPage";
import { fetchHumanActions } from "./api";
import AmbientBackground from "./components/ui/AmbientBackground";
import AgentsNavIcon from "./components/ui/AgentsNavIcon";
import AlertIcon from "./components/ui/AlertIcon";
import Logo from "./components/ui/Logo";

type View = "issues" | "actions" | "agents";

export default function App() {
  const [view, setView] = useState<View>("issues");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentWithHealth[]>([]);
  const [openActionCount, setOpenActionCount] = useState(0);

  const refreshActionCount = useCallback(() => {
    fetchHumanActions().then((actions) => setOpenActionCount(actions.length)).catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => undefined);
    refreshActionCount();
    const poll = setInterval(refreshActionCount, 5000);
    return () => clearInterval(poll);
  }, [refreshActionCount]);

  const goIssues = () => {
    setView("issues");
    setSelectedIssueId(null);
  };

  const navClass = (v: View) =>
    `px-3 py-2 text-base rounded ${view === v ? "bg-cyber-teal/20 text-cyber-teal" : "text-white/60 hover:text-white"}`;

  return (
    <>
      <AmbientBackground />
      <div className="relative z-10 min-h-screen flex flex-col">
        <header className="px-6 py-4 border-b border-white/10 flex flex-wrap gap-4 items-center justify-between glass-header shrink-0">
          <div className="flex items-center gap-6">
            <button type="button" onClick={goIssues} className="flex items-center gap-3 text-left rounded cursor-pointer hover:opacity-90 transition-opacity" aria-label="AgentDealer — go to Issues">
              <Logo size={40} />
              <div>
                <h1 className="text-xl font-bold sm:text-2xl" style={{ background: "linear-gradient(to right, #C4B643, #D4C760)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
                  AgentDealer
                </h1>
                <p className="text-sm text-cyber-teal">One issue, one durable coordination record</p>
              </div>
            </button>
            <nav className="flex gap-1">
              <button type="button" onClick={goIssues} className={navClass("issues")}>Issues</button>
              <button type="button" onClick={() => setView("actions")} className={navClass("actions")}>
                Human actions
                {openActionCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-xs bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded tabular-nums border border-red-400/30">
                    <AlertIcon className="w-3 h-3 shrink-0" />
                    {openActionCount}
                  </span>
                )}
              </button>
            </nav>
          </div>
          <button type="button" onClick={() => setView("agents")} className={`${navClass("agents")} inline-flex items-center gap-1.5`} aria-label="Agents" title="Agents">
            <AgentsNavIcon className="w-6 h-6 shrink-0" />
          </button>
        </header>

        <main className="flex-1 flex overflow-hidden">
          {view === "issues" && !selectedIssueId && <IssuesListPage agents={agents} onSelectIssue={setSelectedIssueId} />}
          {view === "issues" && selectedIssueId && <IssueDetailPage issueId={selectedIssueId} onBack={() => setSelectedIssueId(null)} />}
          {view === "actions" && (
            <HumanActionsPage
              onSelectIssue={(id) => {
                setView("issues");
                setSelectedIssueId(id);
              }}
            />
          )}
          {view === "agents" && <AgentsPage agents={agents} agentDeckOnline={false} onRefresh={() => undefined} />}
        </main>
      </div>
    </>
  );
}
```

**Note for the implementer:** the inline `fetch("/api/agents")` and the `agentDeckOnline={false}`/`onRefresh={() => undefined}` props passed to `AgentsPage` are a simplification — the old `App.tsx` got both from `QueueSnapshot`, which this plan doesn't fetch anymore (it was `runs`-oriented). `AgentsPage`'s actual prop contract should be checked against `apps/web/src/pages/AgentsPage.tsx` before finalizing; if `onRefresh` is load-bearing (e.g. after creating an agent), wire it to a real refetch instead of a no-op. This is flagged, not silently glossed over.

- [ ] **Step 2: Verify — typecheck and build**

```bash
npm run typecheck -w @agent-dealer/web
npm run build -w @agent-dealer/web
```
Expected: both PASS with no errors.

- [ ] **Step 3: Manual verification — dev server smoke test**

```bash
npm run dev -w @agent-dealer/server &  # or however this repo normally starts the API
npm run dev -w @agent-dealer/web
```
Open the printed local URL and confirm, per the spec's five-second-state test (PRD §12):
1. The nav shows Issues / Human actions / Agents, no Operations/Inbox/Done.
2. Issues list loads (empty state renders cleanly if there's no data).
3. Creating an issue via "New issue" succeeds and appears in the list.
4. Clicking an issue opens the detail view with header, timeline, forecast rail, and a working "back" link.
5. Human actions page loads (empty state is fine).
6. Agents page still renders.

Stop both dev servers when done. This step has no automated pass/fail — record what you saw in your report.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "Replace Operations/Inbox/Done nav with Issues/Human actions/Agents (NOT-57)"
```

---

## Plan Self-Review Notes

- **Spec coverage:** PRD §7.2 (issues list row shape), §7.3 (header), §7.4 (timeline + composer), §7.5 (intent forecast rail), §7.6 (human-action queue with resolve) each have a task. §7.7 (agent profile form) is explicitly out of scope per the spec itself ("kept largely as-is... not a required rewrite for this ticket").
- **Deliberately deferred, not hidden (see Global Constraints):** Linear-import UI (CLI already covers it), deletion of orphaned Operations/Intake/Done/RunDrawer/RunCard files, and the `AgentsPage` prop-wiring simplification flagged inline in Task 5.
- **No automated UI tests** — this is a pre-existing fact about `apps/web`, not a gap introduced here; verification is typecheck + build + the manual walkthrough in Task 5 Step 3, matching the spec's own stated testing plan.
- **Type consistency check:** every component's props and the shapes returned by `api.ts` (Task 1) match what Plan 3's routes actually return (`IssueListRow`, `IssueDetail`, `IssueEvidence` mirror the JSON shapes in `routes/issues.ts`/`routes/human-actions.ts` field-for-field). `HumanActionsPage`'s `CHOICES` map matches `resolveHumanActionOutcome`'s accepted `choice` strings from Plan 3 Task 2 exactly.
