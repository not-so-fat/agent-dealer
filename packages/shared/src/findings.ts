import { z } from "zod";

export const FindingSeverity = z.enum(["blocking", "non_blocking"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FindingStatus = z.enum(["open", "resolved", "recurring", "superseded"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Finding = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  fingerprint: z.string(),
  severity: FindingSeverity,
  title: z.string(),
  rationale: z.string(),
  evidenceRef: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  status: FindingStatus,
  firstRound: z.number().int().min(1),
  lastRound: z.number().int().min(1),
});
export type Finding = z.infer<typeof Finding>;
