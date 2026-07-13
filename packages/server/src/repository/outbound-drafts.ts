import type { Artifact, OutboundDraftContent, OutboundToolCall } from "@agent-dealer/shared";
import {
  applyOutboundBodyEdit,
  isOutboundDraftKind,
  outboundMessageMatchesSummary,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { listArtifacts } from "./runs.js";

export type PendingOutboundDraft = {
  artifact: Artifact;
  content: OutboundDraftContent;
};

export function getPendingOutboundDraft(runId: string): PendingOutboundDraft | null {
  const arts = listArtifacts(runId).filter((a) => isOutboundDraftKind(a.kind) && a.contentJson);
  for (let i = arts.length - 1; i >= 0; i--) {
    const art = arts[i];
    try {
      const content = JSON.parse(art.contentJson!) as OutboundDraftContent;
      if (content.status === "pending") {
        return { artifact: art, content };
      }
    } catch {
      // skip
    }
  }
  return null;
}

export function pendingSendCount(runId: string): number {
  return getPendingOutboundDraft(runId) ? 1 : 0;
}

export function rejectPendingOutboundDrafts(runId: string): void {
  const now = new Date().toISOString();
  const db = getDb();
  for (const art of listArtifacts(runId)) {
    if (!isOutboundDraftKind(art.kind) || !art.contentJson) continue;
    try {
      const content = JSON.parse(art.contentJson) as OutboundDraftContent;
      if (content.status !== "pending") continue;
      const next = { ...content, status: "rejected" as const, rejectedAt: now };
      db.prepare("UPDATE artifacts SET content_json = ? WHERE id = ?").run(JSON.stringify(next), art.id);
    } catch {
      // skip
    }
  }
}

/** Apply human body edit to a pending draft artifact. Returns false if not pending. */
export function patchPendingOutboundBody(artifactId: string, body: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT content_json FROM artifacts WHERE id = ?").get(artifactId) as
    | { content_json: string }
    | undefined;
  if (!row?.content_json) return false;
  let content: OutboundDraftContent;
  try {
    content = JSON.parse(row.content_json) as OutboundDraftContent;
  } catch {
    return false;
  }
  if (content.status !== "pending") return false;
  const draft = applyOutboundBodyEdit(content.draft, body);
  const next: OutboundDraftContent = {
    ...content,
    draft,
    bodyMismatch: !outboundMessageMatchesSummary(draft.toolCall, draft.summary.body),
  };
  const result = db
    .prepare("UPDATE artifacts SET content_json = ? WHERE id = ? AND content_json = ?")
    .run(JSON.stringify(next), artifactId, row.content_json);
  return result.changes === 1;
}

/** Revert sent → pending after a failed deliver attempt. Returns false if not sent. */
export function revertOutboundDraftToPending(artifactId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT content_json FROM artifacts WHERE id = ?").get(artifactId) as
    | { content_json: string }
    | undefined;
  if (!row?.content_json) return false;
  let content: OutboundDraftContent;
  try {
    content = JSON.parse(row.content_json) as OutboundDraftContent;
  } catch {
    return false;
  }
  if (content.status !== "sent") return false;
  const next: OutboundDraftContent = { ...content, status: "pending", sentAt: undefined };
  const result = db
    .prepare("UPDATE artifacts SET content_json = ? WHERE id = ? AND content_json = ?")
    .run(JSON.stringify(next), artifactId, row.content_json);
  return result.changes === 1;
}

/** Atomic pending → sent transition. Returns false if not pending. */
export function markOutboundDraftSent(artifactId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT content_json FROM artifacts WHERE id = ?").get(artifactId) as
    | { content_json: string }
    | undefined;
  if (!row?.content_json) return false;
  let content: OutboundDraftContent;
  try {
    content = JSON.parse(row.content_json) as OutboundDraftContent;
  } catch {
    return false;
  }
  if (content.status !== "pending") return false;
  const next: OutboundDraftContent = { ...content, status: "sent", sentAt: new Date().toISOString() };
  const result = db
    .prepare("UPDATE artifacts SET content_json = ? WHERE id = ? AND content_json = ?")
    .run(JSON.stringify(next), artifactId, row.content_json);
  return result.changes === 1;
}

export const deliverInFlight = new Set<string>();

export type DeliverFn = (
  deckId: string,
  toolCall: OutboundToolCall,
  ctx?: { workspaceRoot?: string }
) => Promise<{ toolResult: unknown; permalink?: string }>;
