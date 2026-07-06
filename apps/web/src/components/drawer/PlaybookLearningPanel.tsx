import type { Artifact, PlaybookPatchContent, ReflectStatusContent, Run } from "@agent-dealer/shared";
import { applyPlaybookPatch, dismissPlaybookPatch, latestArtifact, parseArtifact } from "../../api";

type Props = {
  run: Run;
  artifacts: Artifact[];
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
};

function latestPatch(artifacts: Artifact[]): PlaybookPatchContent | null {
  const art = latestArtifact(artifacts, "playbook_patch");
  if (!art) return null;
  try {
    return parseArtifact<PlaybookPatchContent>(art);
  } catch {
    return null;
  }
}

function reflectStatus(artifacts: Artifact[]): ReflectStatusContent | null {
  const art = latestArtifact(artifacts, "reflect_status");
  if (!art) return null;
  try {
    return parseArtifact<ReflectStatusContent>(art);
  } catch {
    return null;
  }
}

/** Post-run playbook learning — propose-confirm apply per D3. */
export default function PlaybookLearningPanel({ run, artifacts, busy, act }: Props) {
  if (!run.playbookId) return null;

  const patch = latestPatch(artifacts);
  const reflect = reflectStatus(artifacts);
  const runtime = run.runtime ?? "claude_code";

  if (runtime === "cursor_local") {
    return (
      <section className="space-y-2">
        <div className="heading-section">Playbook learning</div>
        <p className="text-sm text-white/45">
          Playbook learning requires Claude Code runtime (Cursor has no Agent Deck MCP).
        </p>
      </section>
    );
  }

  if (reflect?.status === "pending" && !patch) {
    return (
      <section className="space-y-2">
        <div className="heading-section">Playbook learning</div>
        <p className="text-sm text-white/45">Analyzing for playbook improvements…</p>
      </section>
    );
  }

  if (!patch) {
    if (reflect?.status === "failed") {
      return (
        <section className="space-y-2">
          <div className="heading-section">Playbook learning</div>
          <p className="text-sm text-white/45">{reflect.error ?? "Reflect step failed"}</p>
        </section>
      );
    }
    if (reflect?.status === "completed" && reflect.error) {
      return (
        <section className="space-y-2">
          <div className="heading-section">Playbook learning</div>
          <p className="text-sm text-white/45">{reflect.error}</p>
        </section>
      );
    }
    return null;
  }

  const isProposed = patch.status === "proposed";
  const isApplied = patch.status === "applied";
  const isDismissed = patch.status === "dismissed";

  return (
    <section className="space-y-3">
      <div className="heading-section">Playbook learning</div>
      {patch.playbookTitle && (
        <p className="text-sm text-white/45">
          {patch.playbookTitle} <span className="text-white/30">({patch.playbookId})</span>
        </p>
      )}
      <p className="text-sm text-white/55">{patch.rationale}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="text-xs text-white/40 uppercase tracking-wide">Current</div>
          <textarea className="field-mono min-h-[120px] resize-y text-sm" value={patch.previousBody} readOnly />
        </div>
        <div className="space-y-1">
          <div className="text-xs text-white/40 uppercase tracking-wide">Proposed</div>
          <textarea className="field-mono min-h-[120px] resize-y text-sm" value={patch.proposedBody} readOnly />
        </div>
      </div>

      {isProposed && (
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => applyPlaybookPatch(run.id))}
            className="btn-gold px-4 py-2 disabled:opacity-40"
          >
            Apply to playbook
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => dismissPlaybookPatch(run.id))}
            className="btn-ghost px-4 py-2 disabled:opacity-40"
          >
            Dismiss
          </button>
        </div>
      )}
      {isApplied && (
        <p className="text-sm text-[#92E4DD]/80">
          Applied to playbook{patch.appliedAt ? ` · ${new Date(patch.appliedAt).toLocaleString()}` : ""}
        </p>
      )}
      {isDismissed && <p className="text-sm text-white/40">Dismissed — playbook unchanged</p>}
    </section>
  );
}
