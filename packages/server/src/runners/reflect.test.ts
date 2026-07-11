import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflectProposalSchema } from "@agent-dealer/shared";

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

test("parseReflectProposal accepts item-delta ops JSON", () => {
  const raw = JSON.stringify({
    rationale: "Retry feedback showed missing verification step",
    ops: [{ op: "add_item", section: "Checklist", text: "Run flow:verify before handoff" }],
    evidence: {
      failure_summary: "Shipped without API gate",
      user_feedback_excerpt: "you forgot flow:verify",
    },
  });
  const parsed = parseReflectProposal(raw);
  assert.ok(parsed);
  assert.equal(parsed!.ops.length, 1);
  assert.equal(parsed!.ops[0]!.op, "add_item");
});

test("parseReflectProposal rejects empty ops", () => {
  const raw = JSON.stringify({
    rationale: "No lesson",
    ops: [],
  });
  assert.equal(parseReflectProposal(raw), null);
});

test("parseReflectProposal rejects legacy proposedBody shape", () => {
  const raw = JSON.stringify({
    rationale: "old shape",
    proposedBody: "# Playbook\n",
  });
  assert.equal(parseReflectProposal(raw), null);
});
