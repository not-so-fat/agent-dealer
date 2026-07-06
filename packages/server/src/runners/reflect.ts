import type { PlaybookPatchContent, PlaybookPatchTrigger, Run } from "@agent-dealer/shared";
import { addArtifact, getLatestArtifact } from "../repository/runs.js";
import { fetchPlaybook } from "../adapters/agent-deck.js";
import { runClaude } from "./claude.js";
import { buildReflectPrompt } from "./prompts.js";
import { extractResultText, parseNdjson } from "./stream-json.js";

export interface ReflectOpts {
  trigger: PlaybookPatchTrigger;
  feedback?: string;
}

function parseReflectProposal(text: string): { rationale: string; proposedBody: string } | null {
  const trimmed = text.trim();
  const jsonFence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [jsonFence?.[1] ?? trimmed, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { rationale?: string; proposedBody?: string };
      if (parsed.rationale?.trim() && parsed.proposedBody?.trim()) {
        return { rationale: parsed.rationale.trim(), proposedBody: parsed.proposedBody.trim() };
      }
    } catch {
      // try next
    }
  }
  return null;
}

export async function runReflect(run: Run, opts: ReflectOpts): Promise<void> {
  if (!run.playbookId || !run.deckId) return;
  if ((run.runtime ?? "claude_code") !== "claude_code") {
    addArtifact(
      run.id,
      "reflect_status",
      { status: "skipped", trigger: opts.trigger, error: "Playbook learning requires Claude Code runtime" },
      "system"
    );
    return;
  }

  addArtifact(run.id, "reflect_status", { status: "pending", trigger: opts.trigger }, "system");

  try {
    const playbook = await fetchPlaybook(run.playbookId);
    const previousBody = playbook.body ?? "";

    const result = await runClaude(run, "reflect", undefined, buildReflectPrompt(run, opts));
    const events = parseNdjson(result.transcript);
    const resultText = extractResultText(events) ?? result.transcript;
    const proposal = parseReflectProposal(resultText);

    if (!proposal || result.exitCode !== 0) {
      addArtifact(
        run.id,
        "reflect_status",
        {
          status: "failed",
          trigger: opts.trigger,
          error: proposal ? "Reflect agent failed" : "Could not parse reflect proposal JSON",
        },
        "system"
      );
      return;
    }

    if (proposal.proposedBody.trim() === previousBody.trim()) {
      addArtifact(
        run.id,
        "reflect_status",
        { status: "completed", trigger: opts.trigger, error: "No playbook changes proposed" },
        "system"
      );
      return;
    }

    const patch: PlaybookPatchContent = {
      playbookId: run.playbookId,
      playbookTitle: playbook.title,
      previousBody,
      proposedBody: proposal.proposedBody,
      rationale: proposal.rationale,
      status: "proposed",
      trigger: opts.trigger,
    };
    addArtifact(run.id, "playbook_patch", patch, "agent", result.logPath);
    addArtifact(run.id, "reflect_status", { status: "completed", trigger: opts.trigger }, "system");
  } catch (err) {
    addArtifact(
      run.id,
      "reflect_status",
      { status: "failed", trigger: opts.trigger, error: String(err) },
      "system"
    );
  }
}

export function latestProposedPatch(runId: string): PlaybookPatchContent | null {
  const art = getLatestArtifact(runId, "playbook_patch");
  if (!art?.contentJson) return null;
  try {
    const parsed = JSON.parse(art.contentJson) as PlaybookPatchContent;
    return parsed.status === "proposed" ? parsed : null;
  } catch {
    return null;
  }
}
