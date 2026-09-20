// NOT-180: production entry point for per-attempt native Muse Code configuration.
//
// The implementation lives in muse-config-core.ts, which pins `prepareMuseAttempt` to
// `NOT_177_EVIDENCE`. No module in the build exports a preparer that accepts caller-supplied evidence.
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
  prepareMuseAttempt,
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
