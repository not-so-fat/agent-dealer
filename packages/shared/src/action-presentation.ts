// NOT-288: one shared presentation read of a human action for every friend-path
// surface (Issues home NeedsAttentionPanel, Issue Detail). The stored
// `question`/`reason` still carry the full folded recovery text (paths, git
// commands, SHAs) so the timeline and evidence stay auditable and pre-change
// open actions keep working — this layer only derives a short question, a
// one-sentence next step, and the expandable Details from those stored fields.

export interface ActionPresentationInput {
  actionType: string;
  question: string;
  reason: string;
  evidenceJson: string | null;
  responseOptionsJson: string | null;
  continuationPreviewJson: string | null;
}

export type ActionSummaryKind =
  | "diverged-push"
  | "unpushed"
  | "worktree-conflict"
  | "dirty-worktree"
  | "merge-failure"
  | "reviewer-retry"
  | "ordinary-escalation"
  | "other";

export interface ActionResponseOption {
  choice: string;
  label: string;
}

export interface ActionSummaryDetails {
  /** Full stored question, verbatim — never truncated. */
  question: string;
  /** Full stored reason, verbatim — never truncated. */
  reason: string;
  /** Exact recovery commands parsed out of the reason. */
  commands: string[];
  /** Worktree / log paths parsed out of the reason, question, and evidence. */
  paths: string[];
  /** Structured recovery facts (push pins, continuation, review verdict). */
  factLines: string[];
  /** Full structured evidence, pretty-printed — null when the action has none. */
  evidencePretty: string | null;
}

export interface ActionSummary {
  kind: ActionSummaryKind;
  /** Short human question for the default (collapsed) view. */
  title: string;
  /** One-sentence blocker / next-step context, or null when there is none. */
  context: string | null;
  /**
   * True only where coordinator semantics prove Resume continues without
   * discarding preserved work or re-colliding with the same blocker: a
   * reviewer-origin retry (fresh reviewer at a pinned head, no worktree
   * touched) or an ordinary escalation with no preserved-work markers.
   * Worktree conflicts, dirty worktrees, and unpushed/diverged pushes keep
   * their preserved work — never safe to promise.
   */
  safeResume: boolean;
  /** Server-declared choices, with `resume` shown as "Resume safely" only when safeResume. */
  displayOptions: ActionResponseOption[];
  /** The safest server-declared next action: push_with_lease for a diverged push,
   * otherwise the first non-destructive choice. Null when no options exist. */
  primaryChoice: string | null;
  details: ActionSummaryDetails;
}

interface PushDivergenceFacts {
  branch?: string;
  localSha?: string;
  remoteSha?: string;
  ahead?: number;
  behind?: number;
  relationship?: string;
  worktreePath?: string | null;
  observedRemoteSha?: string;
  lastLeaseError?: string;
}

function parseJsonSafe<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function parseActionResponseOptions(action: ActionPresentationInput): ActionResponseOption[] {
  const parsed = parseJsonSafe<ActionResponseOption[]>(action.responseOptionsJson);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((o) => typeof o?.choice === "string" && typeof o?.label === "string");
}

function parseEvidence(action: ActionPresentationInput): Record<string, unknown> {
  return parseJsonSafe<Record<string, unknown>>(action.evidenceJson) ?? {};
}

function pushFacts(action: ActionPresentationInput): PushDivergenceFacts | null {
  const evidence = parseEvidence(action);
  const facts = evidence["pushDivergence"];
  if (!facts || typeof facts !== "object") return null;
  return facts as PushDivergenceFacts;
}

function hasWorktreeBlockerEvidence(action: ActionPresentationInput): boolean {
  const evidence = parseEvidence(action);
  const blocker = evidence["worktreeBlocker"];
  return (
    !!blocker &&
    typeof blocker === "object" &&
    typeof (blocker as { fingerprint?: unknown }).fingerprint === "string"
  );
}

function isMergeFailureEvidence(action: ActionPresentationInput): boolean {
  return parseEvidence(action)["mergeFailure"] === true;
}

function resumeContinuationRole(action: ActionPresentationInput): string | null {
  const parsed = parseJsonSafe<{ resumeRole?: unknown }>(action.continuationPreviewJson);
  return typeof parsed?.resumeRole === "string" ? parsed.resumeRole : null;
}

/** Signals that local work is preserved and Resume cannot be promised safe. */
const PRESERVED_WORK_PATTERN =
  /worktree|unpushed|uncommitted|dirty|preserved|non-fast-forward|diverged|already used by|recovery:|force-with-lease/i;

const UNPUSHED_TEXT_PATTERN = /could not be pushed|non-fast-forward|rejected.*push|push.*rejected/i;
const DIRTY_TEXT_PATTERN = /uncommitted|dirty worktree|has uncommitted changes/i;

/** Splits the folded "Recovery:\n<commands>" tail the coordinator appends to reasons. */
function splitRecovery(reason: string): { head: string; commands: string[] } {
  const marker = /\n?Recovery:\s*\n?/;
  const match = reason.match(marker);
  if (!match || match.index === undefined) return { head: reason.trim(), commands: [] };
  const head = reason.slice(0, match.index).trim();
  const tail = reason.slice(match.index + match[0].length);
  const commands = tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { head, commands };
}

/** First sentence of a blocker statement — the one-sentence context source. */
function firstSentence(text: string): string {
  const head = splitRecovery(text).head;
  const singleLine = head.replace(/\s+/g, " ").trim();
  const match = singleLine.match(/^(.+?[.!?])(\s|$)/);
  return (match ? match[1] : singleLine).trim();
}

const PATH_PATTERN = /(?:~|\/(?:[^/\s\\:"'*?<>|][^/\s\\:"'*?<>|]*))+(?:\/[^/\s\\:"'*?<>|]+)*/g;

/** Absolute worktree/log paths from free text plus the structured evidence path. */
function extractPaths(action: ActionPresentationInput): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const trimmed = p.trim().replace(/[.,;:!?)"'\]]+$/, "");
    if (trimmed.length < 2 || seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push(trimmed);
  };
  for (const text of [action.reason, action.question]) {
    for (const match of text.matchAll(PATH_PATTERN)) {
      const candidate = match[0];
      // Guard against version numbers and SHAs matching the loose pattern.
      if (/^\/\d+(\.\d+)*$/.test(candidate)) continue;
      if (!candidate.includes("/") && !candidate.startsWith("~")) continue;
      push(candidate);
    }
  }
  const facts = pushFacts(action);
  if (typeof facts?.worktreePath === "string" && facts.worktreePath) push(facts.worktreePath);
  return found;
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/** Recovery facts both panels show the same way: pins, tips, continuation. */
function factLines(action: ActionPresentationInput): string[] {
  const lines: string[] = [];
  const facts = pushFacts(action);
  if (facts && typeof facts.localSha === "string" && typeof facts.remoteSha === "string") {
    const branch = typeof facts.branch === "string" ? facts.branch : "the branch";
    const ahead = typeof facts.ahead === "number" ? ` (+${facts.ahead})` : "";
    const behind = typeof facts.behind === "number" ? ` (+${facts.behind})` : "";
    lines.push(`Push: local ${facts.localSha}${ahead} · origin/${branch} ${facts.remoteSha}${behind}`);
    if (typeof facts.observedRemoteSha === "string" && facts.observedRemoteSha !== facts.remoteSha) {
      lines.push(`Remote moved: origin/${branch} is now at ${facts.observedRemoteSha}`);
    }
    if (typeof facts.lastLeaseError === "string" && facts.lastLeaseError) {
      lines.push(`Last lease attempt: ${facts.lastLeaseError}`);
    }
  }
  const role = resumeContinuationRole(action);
  if (role) lines.push(`Continuation: resumes as ${role}`);
  return lines;
}

function isDestructiveChoice(choice: string): boolean {
  return choice === "close" || choice === "reject" || choice === "abort";
}

function primaryChoiceFor(options: ActionResponseOption[]): string | null {
  if (options.length === 0) return null;
  if (options.some((o) => o.choice === "push_with_lease")) return "push_with_lease";
  return (options.find((o) => !isDestructiveChoice(o.choice)) ?? options[0]).choice;
}

function classify(action: ActionPresentationInput): ActionSummaryKind {
  if (action.actionType !== "policy_escalation") return "other";
  if (isMergeFailureEvidence(action)) return "merge-failure";
  const facts = pushFacts(action);
  if (facts?.relationship === "diverged") return "diverged-push";
  if (facts && (facts.relationship === "behind" || typeof facts.localSha === "string")) return "unpushed";
  const text = `${action.reason}\n${action.question}`;
  if (UNPUSHED_TEXT_PATTERN.test(text)) return "unpushed";
  // A reviewer-origin retry re-queues a fresh reviewer at a pinned head without
  // touching a developer worktree — classify before the generic worktree text
  // check so a "reviewer worktree checkout failed" reason still reads as safe.
  if (resumeContinuationRole(action) === "reviewer") return "reviewer-retry";
  // Dirty before worktree: a preserved-dirt escalation names its worktree path in
  // the recovery commands but stays a dirty worktree, not a branch collision.
  if (DIRTY_TEXT_PATTERN.test(text)) return "dirty-worktree";
  if (
    hasWorktreeBlockerEvidence(action) ||
    /already used by worktree/i.test(text) ||
    (/worktree/i.test(text) && /Recovery:/.test(text))
  ) {
    return "worktree-conflict";
  }
  return "ordinary-escalation";
}

const SAFE_RESUME_LABEL = "Resume safely";

export function summarizeHumanAction(action: ActionPresentationInput): ActionSummary {
  const kind = classify(action);
  const options = parseActionResponseOptions(action);
  const { commands } = splitRecovery(action.reason);
  const paths = extractPaths(action);
  const facts = factLines(action);
  const evidencePretty = (() => {
    const evidence = parseJsonSafe<unknown>(action.evidenceJson);
    if (evidence === null || evidence === undefined) return null;
    return JSON.stringify(evidence, null, 2);
  })();
  const details: ActionSummaryDetails = {
    question: action.question,
    reason: action.reason,
    commands,
    paths,
    factLines: facts,
    evidencePretty,
  };

  switch (kind) {
    case "diverged-push": {
      const f = pushFacts(action);
      const pin =
        f && typeof f.branch === "string" && typeof f.localSha === "string" && typeof f.remoteSha === "string"
          ? ` (origin/${f.branch}: local ${shortSha(f.localSha)} against remote ${shortSha(f.remoteSha)})`
          : "";
      return {
        kind,
        title: "Publish these finished commits with a pinned lease?",
        context: `Your branch diverged from the remote — confirm the pinned commits${pin} under Details, then choose Push with lease.`,
        safeResume: false,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
    }
    case "unpushed":
      return {
        kind,
        title: "The push was rejected — how should we proceed?",
        context: "Your commits are saved; resuming continues development without discarding them.",
        safeResume: false,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
    case "worktree-conflict":
      return {
        kind,
        title: "A saved worktree still holds this branch — how should we proceed?",
        context: "Your work is preserved; check the worktree path and recovery steps under Details before choosing.",
        safeResume: false,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
    case "dirty-worktree":
      return {
        kind,
        title: "Uncommitted changes were preserved — how should we proceed?",
        context: "Nothing was discarded; review the saved changes under Details before choosing.",
        safeResume: false,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
    case "merge-failure":
      return {
        kind,
        title: "The merge failed after approval — retry it?",
        context: "The work is already approved; retrying the merge publishes the same commits without a new developer round.",
        safeResume: false,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
    case "reviewer-retry":
      return {
        kind,
        title: "The review attempt failed — retry it?",
        context: "Nothing is wrong with the code itself; retrying re-queues the reviewer at the same pinned commit.",
        safeResume: true,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
    case "ordinary-escalation": {
      const blocker = firstSentence(action.reason);
      const safe = !PRESERVED_WORK_PATTERN.test(`${action.reason}\n${action.question}`);
      const displayOptions = safe
        ? options.map((o) =>
            o.choice === "resume" && o.label === "Resume development"
              ? { ...o, label: SAFE_RESUME_LABEL }
              : o
          )
        : options;
      return {
        kind,
        title: "Development is parked — resume or close?",
        context: blocker ? `${blocker} Choose ${safe ? "Resume safely" : "Resume"} to continue, or Close to stop.` : null,
        safeResume: safe,
        displayOptions,
        primaryChoice: primaryChoiceFor(displayOptions),
        details,
      };
    }
    case "other":
    default:
      return {
        kind: "other",
        title: action.question,
        context: null,
        safeResume: false,
        displayOptions: options,
        primaryChoice: primaryChoiceFor(options),
        details,
      };
  }
}
