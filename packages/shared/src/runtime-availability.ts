import { z } from "zod";
import { Runtime } from "./runtime.js";

export const RuntimeAvailabilityAvailable = z.object({
  available: z.literal(true),
});
export type RuntimeAvailabilityAvailable = z.infer<typeof RuntimeAvailabilityAvailable>;

export const RuntimeAvailabilityCapped = z.object({
  available: z.literal(false),
  until: z.string(),
  reason: z.string(),
});
export type RuntimeAvailabilityCapped = z.infer<typeof RuntimeAvailabilityCapped>;

export const RuntimeAvailability = z.discriminatedUnion("available", [
  RuntimeAvailabilityAvailable,
  RuntimeAvailabilityCapped,
]);
export type RuntimeAvailability = z.infer<typeof RuntimeAvailability>;

export interface RuntimeAvailabilityRecord {
  runtime: Runtime;
  unavailableUntil: string;
  reason: string;
  evidenceJson: string | null;
  observedAt: string;
}
