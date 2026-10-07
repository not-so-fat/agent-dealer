// NOT-366: operator text for a window whose acquisition failed. The server
// sends prose (`message`) plus the failure streak; this only formats it, so
// no internal failure-kind identifier can reach the DOM.
import type { CapacityWindowSnapshot } from "@agent-dealer/shared";

/** `unavailable: <why> (<n> consecutive failed refreshes since <when>)`, or
 * null when the window carries no failure detail. */
export function capacityUnavailableText(w: CapacityWindowSnapshot): string | null {
  const d = w.unavailableDetail;
  if (!d) return null;
  const n = d.consecutiveFailures;
  const since = new Date(d.firstFailureAt).toLocaleString();
  return `unavailable: ${d.message} (${n} consecutive failed refresh${n === 1 ? "" : "es"} since ${since})`;
}
