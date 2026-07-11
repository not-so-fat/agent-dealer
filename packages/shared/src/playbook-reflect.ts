import { z } from "zod";

export const PatchEvidenceContent = z.object({
  failure_summary: z.string().min(1),
  user_feedback_excerpt: z.string().min(1),
  corrected_output_hint: z.string().optional(),
});
export type PatchEvidenceContent = z.infer<typeof PatchEvidenceContent>;

export const ReflectPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_item"), section: z.string().min(1), text: z.string().min(1) }),
  z.object({
    op: z.literal("amend_item"),
    section: z.string().min(1),
    anchor: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({ op: z.literal("remove_item"), section: z.string().min(1), anchor: z.string().min(1) }),
  z.object({ op: z.literal("set_triggers"), triggers: z.array(z.string()) }),
  z.object({ op: z.literal("rewrite_body"), text: z.string() }),
]);
export type ReflectPatchOp = z.infer<typeof ReflectPatchOpSchema>;

/** Agent reflect output — item deltas posted to Agent Deck proposal queue. */
export const ReflectProposalSchema = z.object({
  rationale: z.string().min(1),
  ops: z.array(ReflectPatchOpSchema).min(1),
  evidence: PatchEvidenceContent.optional(),
});
export type ReflectProposal = z.infer<typeof ReflectProposalSchema>;
