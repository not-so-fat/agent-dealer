import type { Artifact, PlaybookPatchContent, ReflectStatusContent, Run } from "@agent-dealer/shared";
import { latestArtifact, parseArtifact } from "../../api";

type Props = {
  run: Run;
  artifacts: Artifact[];
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

/** Post-run playbook learning — proposal queued in Agent Deck dashboard (D3). */
export default function PlaybookLearningPanel({ run, artifacts }: Props) {
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

  const reviewUrl = patch.dashboardUrl;

  return (
    <section className="space-y-3">
      <div className="heading-section">Playbook learning</div>
      {patch.playbookTitle && (
        <p className="text-sm text-white/45">
          {patch.playbookTitle}{" "}
          {patch.playbookId && <span className="text-white/30">({patch.playbookId})</span>}
        </p>
      )}
      {patch.rationale && <p className="text-sm text-white/55">{patch.rationale}</p>}
      <p className="text-sm text-[#92E4DD]/80">
        Proposal <span className="font-mono text-white/50">{patch.patchId}</span> queued in Agent Deck
        — accept or reject in the deck review queue.
      </p>
      {reviewUrl && (
        <a
          href={reviewUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block btn-gold px-4 py-2 text-sm no-underline"
        >
          Review in Agent Deck
        </a>
      )}
    </section>
  );
}
