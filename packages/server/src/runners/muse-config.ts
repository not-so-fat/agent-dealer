// NOT-180: production entry point for per-attempt native Muse Code configuration.
//
// The implementation lives in muse-config-core.ts. `prepareMuseAttempt` here is pinned to
// `NOT_177_EVIDENCE`: callers cannot supply their own enforcement evidence, and the
// evidence-parameterized preparer is deliberately not re-exported.
import {
  NOT_177_EVIDENCE,
  prepareWithEvidence,
  type MuseAttempt,
  type MuseAttemptInput,
} from "./muse-config-core.js";

export {
  AGENT_DECK_DENIED_TOOLS,
  AGENT_DECK_READ_TOOLS,
  AGENT_DECK_SERVER,
  MUSE_MODEL,
  MuseIsolationError,
  NOT_177_EVIDENCE,
  assertMuseArgv,
  assertMuseSettings,
  buildMuseArgv,
  buildMuseEnv,
  buildMuseSettings,
  createRedactor,
  defaultOperatorAuthPath,
  unenforceableRestrictions,
} from "./muse-config-core.js";
export type {
  MuseAttempt,
  MuseAttemptInput,
  MuseCapability,
  MuseCredential,
  MuseEnforcementEvidence,
  MuseIsolationCode,
  MuseLaunch,
  MuseRole,
  MuseSettings,
} from "./muse-config-core.js";

/**
 * Validates, refuses unenforceable restrictions, then writes the per-attempt dir. Throws before
 * spawn. Always uses the pinned NOT-177 evidence, under which both roles are currently refused.
 */
export function prepareMuseAttempt(input: MuseAttemptInput): MuseAttempt {
  return prepareWithEvidence(input, NOT_177_EVIDENCE);
}
