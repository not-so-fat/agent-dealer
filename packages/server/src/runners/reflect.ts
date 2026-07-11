import { PlaybookPatchContent, ReflectProposalSchema, type PlaybookPatchTrigger, type Run } from "@agent-dealer/shared";
import { addArtifact, getLatestArtifact } from "../repository/runs.js";
import {
  agentDeckPatchesUrl,
  checkAgentDeckHealth,
  fetchPlaybook,
  proposePlaybookPatch,
} from "../adapters/agent-deck.js";
import { runClaude } from "./claude.js";
import { buildReflectPrompt } from "./prompts.js";
import { extractResultText, parseNdjson } from "./stream-json.js";

export interface ReflectOpts {
  trigger: PlaybookPatchTrigger;
  feedback?: string;
}

function parseReflectProposal(text: string) {
  const trimmed = text.trim();
  const jsonFence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [jsonFence?.[1] ?? trimmed, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = ReflectProposalSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
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
    const healthy = await checkAgentDeckHealth();
    if (!healthy) {
      addArtifact(
        run.id,
        "reflect_status",
        { status: "failed", trigger: opts.trigger, error: "Agent Deck offline" },
        "system"
      );
      return;
    }

    const playbook = await fetchPlaybook(run.playbookId);

    const result = await runClaude(run, "reflect", undefined, { promptOverride: buildReflectPrompt(run, opts) });
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

    const evidence =
      opts.trigger === "retry" && opts.feedback?.trim()
        ? {
            failure_summary:
              proposal.evidence?.failure_summary ??
              "Human requested retry with feedback after reviewing execution",
            user_feedback_excerpt: opts.feedback.trim(),
            corrected_output_hint: proposal.evidence?.corrected_output_hint,
          }
        : proposal.evidence;

    const created = await proposePlaybookPatch(run.deckId, run.id, {
      ...proposal,
      evidence,
      playbook_id: run.playbookId,
    });

    const patch: PlaybookPatchContent = {
      patchId: created.id,
      playbookId: run.playbookId,
      playbookTitle: playbook.title,
      rationale: proposal.rationale,
      status: "proposed",
      trigger: opts.trigger,
      dashboardUrl: agentDeckPatchesUrl(),
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
    const parsed = PlaybookPatchContent.parse(JSON.parse(art.contentJson));
    return parsed.status === "proposed" ? parsed : null;
  } catch {
    return null;
  }
}
