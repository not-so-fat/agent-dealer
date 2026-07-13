import { z } from "zod";

export const OutboundActionType = z.enum(["slack_message", "email"]);
export type OutboundActionType = z.infer<typeof OutboundActionType>;

export const OutboundDraftSummary = z.object({
  target: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
});
export type OutboundDraftSummary = z.infer<typeof OutboundDraftSummary>;

export const OutboundToolCall = z.object({
  serviceName: z.string().min(1).max(120),
  toolName: z.string().min(1).max(120),
  arguments: z.record(z.unknown()),
});
export type OutboundToolCall = z.infer<typeof OutboundToolCall>;

/** Agent output contract — final fenced json block of an execute reply (PRD §7.1). */
export const OutboundDraftBlock = z.object({
  actionType: OutboundActionType,
  summary: OutboundDraftSummary,
  toolCall: OutboundToolCall,
});
export type OutboundDraftBlock = z.infer<typeof OutboundDraftBlock>;

export const OutboundDraftStatus = z.enum(["pending", "sent", "rejected"]);
export type OutboundDraftStatus = z.infer<typeof OutboundDraftStatus>;

/** slack_draft / email_draft artifact contentJson (PRD §7.2). */
export const OutboundDraftContent = z.object({
  draft: OutboundDraftBlock,
  status: OutboundDraftStatus,
  sentAt: z.string().optional(),
  rejectedAt: z.string().optional(),
  bodyMismatch: z.boolean().optional(),
});
export type OutboundDraftContent = z.infer<typeof OutboundDraftContent>;

/** send_receipt artifact contentJson (PRD §7.3). */
export const SendReceiptContent = z.object({
  draftArtifactId: z.string().uuid(),
  sentAt: z.string(),
  toolResult: z.record(z.unknown()),
  permalink: z.string().url().optional(),
});
export type SendReceiptContent = z.infer<typeof SendReceiptContent>;

export function outboundDraftKind(actionType: OutboundActionType): "slack_draft" | "email_draft" {
  return actionType === "slack_message" ? "slack_draft" : "email_draft";
}

const OUTBOUND_DRAFT_KINDS = new Set<string>(["slack_draft", "email_draft"]);

export function isOutboundDraftKind(kind: string): kind is "slack_draft" | "email_draft" {
  return OUTBOUND_DRAFT_KINDS.has(kind);
}

/** Compare summary.body to the message field in toolCall.arguments (Slack: text, email: body). */
export function outboundMessageMatchesSummary(toolCall: OutboundToolCall, body: string): boolean {
  const args = toolCall.arguments;
  const candidates = [args.text, args.body, args.message].filter((v): v is string => typeof v === "string");
  return candidates.some((v) => v === body);
}

const OUTBOUND_BODY_ARG_KEYS = ["text", "body", "message"] as const;

/** Human edit before approve — sync summary.body into the toolCall message field. */
export function applyOutboundBodyEdit(draft: OutboundDraftBlock, body: string): OutboundDraftBlock {
  const args = { ...draft.toolCall.arguments };
  const key = OUTBOUND_BODY_ARG_KEYS.find((k) => typeof args[k] === "string");
  if (key) args[key] = body;
  else args.text = body;

  return {
    ...draft,
    summary: { ...draft.summary, body },
    toolCall: { ...draft.toolCall, arguments: args },
  };
}
