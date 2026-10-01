import { z } from "zod";

/**
 * NOT-306: frozen Dealer execution contracts compiled from Planner-authored
 * Linear tickets.
 *
 * A Planner brief carries its execution semantics as canonical Markdown
 * headings in the ticket description. This module is the ONE implementation
 * that parses, validates, and structures those headings — shared by the web
 * intake, the API routes, and (through the API) the CLI, so no intake path
 * keeps its own regex or drifts from the others.
 *
 * The ticket description stays the untouched source of truth; the contract is
 * derived data. A description with none of the canonical headings is a
 * compatible legacy issue (contract `null`) and existing/manual issues are
 * never blocked.
 */

export const EXECUTION_CONTRACT_VERSION = "v1" as const;

export const ExecutionMode = z.enum(["feature", "bug fix", "refactor", "investigation", "split child"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

const EXECUTION_MODES: readonly string[] = ExecutionMode.options;

export const ExecutionContractCriterion = z.object({
  text: z.string(),
  /** Raw `Evidence:` line body (where to look, action/command, expected result). */
  evidence: z.string().nullable(),
});
export type ExecutionContractCriterion = z.infer<typeof ExecutionContractCriterion>;

export const ExecutionContractV1 = z.object({
  version: z.literal(EXECUTION_CONTRACT_VERSION),
  executionMode: ExecutionMode,
  nonGoals: z.array(z.string()),
  exitPredicate: z.string(),
  onePrStoppingPoint: z.string(),
  acceptanceCriteria: z.array(ExecutionContractCriterion),
});
export type ExecutionContractV1 = z.infer<typeof ExecutionContractV1>;

/** Display names of the canonical `##` headings, in ticket order. */
export const EXECUTION_CONTRACT_HEADINGS = {
  executionMode: "Builder execution mode",
  nonGoals: "Non-goals",
  exitPredicate: "Exit predicate",
  onePrStoppingPoint: "One-PR stopping point",
  acceptanceCriteria: "Acceptance criteria",
} as const;

/** Actionable validation failure — callers map this to a 400, never a silent drop. */
export class ExecutionContractError extends Error {
  constructor(message: string) {
    super(`Execution contract: ${message}`);
    this.name = "ExecutionContractError";
  }
}

type SectionKey = keyof typeof EXECUTION_CONTRACT_HEADINGS;

const SECTION_KEYS = Object.keys(EXECUTION_CONTRACT_HEADINGS) as SectionKey[];

/** Canonical key for a raw `##` heading: lowercase, hyphens→spaces, collapsed. */
function normalizeHeadingName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

const CANONICAL_BY_NORMALIZED: Record<string, SectionKey> = Object.fromEntries(
  SECTION_KEYS.map((key) => [
    normalizeHeadingName(EXECUTION_CONTRACT_HEADINGS[key]),
    key,
  ]),
) as Record<string, SectionKey>;

/** The four Planner-signal headings. `Acceptance criteria` alone stays legacy. */
const SIGNAL_KEYS: readonly SectionKey[] = [
  "executionMode",
  "nonGoals",
  "exitPredicate",
  "onePrStoppingPoint",
];

interface RawSection {
  /** Exact heading text as written (for error messages). */
  name: string;
  key: SectionKey;
  body: string;
}

/** Split Markdown into `##`-level sections (only `##`, never `#` or `###`). */
function splitSections(description: string): Array<{ name: string; body: string }> {
  const lines = description.split("\n");
  const sections: Array<{ name: string; body: string }> = [];
  let current: { name: string; body: string[] } | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading?.[1] !== undefined) {
      if (current) sections.push({ name: current.name, body: current.body.join("\n") });
      current = { name: heading[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ name: current.name, body: current.body.join("\n") });
  return sections;
}

/** Normalize an execution-mode value (`Bug-Fix` → `bug fix`); null when unknown. */
function normalizeExecutionMode(raw: string): ExecutionMode | null {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Planner tickets punctuate the value as prose (`Feature.`); trailing
    // sentence punctuation is not part of the mode.
    .replace(/[.\u3002!?;:,'"\)\]]+$/g, "")
    .trim();
  if (collapsed === "bugfix") return "bug fix";
  const found = EXECUTION_MODES.find((m) => m === collapsed);
  return (found ?? null) as ExecutionMode | null;
}

function requireSection(sections: Map<SectionKey, RawSection>, key: SectionKey): RawSection {
  const section = sections.get(key);
  if (!section) {
    throw new ExecutionContractError(
      `missing \`## ${EXECUTION_CONTRACT_HEADINGS[key]}\` — a ticket with any execution-contract heading must carry all five contract sections`
    );
  }
  return section;
}

function parseNonGoals(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (!item?.[1]) {
      throw new ExecutionContractError(
        `\`## Non-goals\` must be a Markdown list — got a non-list line: "${line.trim()}"`
      );
    }
    items.push(item[1]);
  }
  if (items.length === 0) {
    throw new ExecutionContractError("`## Non-goals` must list at least one non-goal");
  }
  return items;
}

function parseExitPredicate(body: string): string {
  const text = body.trim();
  if (!text) {
    throw new ExecutionContractError("`## Exit predicate` must be one observable completion statement (got empty)");
  }
  if (/\n\s*\n/.test(text)) {
    throw new ExecutionContractError(
      "`## Exit predicate` must be one observable completion statement (a single paragraph)"
    );
  }
  return text;
}

function parseOnePrStoppingPoint(body: string): string {
  const text = body.trim();
  if (!text) {
    throw new ExecutionContractError("`## One-PR stopping point` must state the boundary where this worker must stop (got empty)");
  }
  return text;
}

const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
// Planner/Linear evidence lines carry the ticket's nested bullet (`  * Evidence: ...`);
// accept an optional bullet marker so that canonical shape parses as evidence.
const EVIDENCE_RE = /^\s*(?:[-*+]\s+)?Evidence\s*:\s*(.*)$/i;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

function normalizeCriterionText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseAcceptanceCriteria(body: string): ExecutionContractCriterion[] {
  const criteria: ExecutionContractCriterion[] = [];
  const seen = new Map<string, string>();
  let current: ExecutionContractCriterion | null = null;
  let hasEvidence = false;
  const flush = () => {
    if (current) criteria.push(current);
    current = null;
    hasEvidence = false;
  };
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const checkbox = line.match(CHECKBOX_RE);
    if (checkbox) {
      flush();
      const text = (checkbox[2] ?? "").trim();
      if (!text) {
        throw new ExecutionContractError("`## Acceptance criteria` has a checkbox item with no text");
      }
      const key = normalizeCriterionText(text);
      const first = seen.get(key);
      if (first !== undefined) {
        throw new ExecutionContractError(
          `\`## Acceptance criteria\` has a duplicate criterion: "${first}" — keep each criterion exactly once`
        );
      }
      seen.set(key, text);
      current = { text, evidence: null };
      continue;
    }
    const evidence = line.match(EVIDENCE_RE);
    if (evidence) {
      if (!current) {
        throw new ExecutionContractError(
          "`## Acceptance criteria` has an `Evidence:` line before any criterion — indent it under the criterion it belongs to"
        );
      }
      if (hasEvidence) {
        throw new ExecutionContractError(
          `\`## Acceptance criteria\` has two \`Evidence:\` lines for one criterion ("${current.text}") — keep exactly one`
        );
      }
      const value = (evidence[1] ?? "").trim();
      if (!value) {
        throw new ExecutionContractError(
          `\`## Acceptance criteria\` has an empty \`Evidence:\` line for "${current.text}" — state where to look, the action/command, and the expected result`
        );
      }
      current.evidence = value;
      hasEvidence = true;
      continue;
    }
    if (BULLET_RE.test(line)) {
      throw new ExecutionContractError(
        `\`## Acceptance criteria\` items must be checkboxes (\`- [ ] text\`) with an optional indented \`Evidence:\` line — got a plain bullet: "${line.trim()}"`
      );
    }
    throw new ExecutionContractError(
      `\`## Acceptance criteria\` lines must be \`- [ ]\` checkbox items or indented \`Evidence:\` lines — got: "${line.trim()}"`
    );
  }
  flush();
  if (criteria.length === 0) {
    throw new ExecutionContractError("`## Acceptance criteria` must contain at least one `- [ ]` checkbox item");
  }
  return criteria;
}

/** Re-serialize contract criteria as the legacy acceptance-criteria text column. */
export function renderContractAcceptanceCriteria(contract: ExecutionContractV1): string {
  const lines: string[] = [];
  for (const criterion of contract.acceptanceCriteria) {
    lines.push(`- [ ] ${criterion.text}`);
    if (criterion.evidence) lines.push(`  Evidence: ${criterion.evidence}`);
  }
  return lines.join("\n");
}

export interface CompiledContract {
  /** Non-null only when a Planner-signal heading makes this a contract ticket. */
  contract: ExecutionContractV1 | null;
  /**
   * Acceptance-criteria text derived from the description: the raw section for
   * an AC-only (legacy) ticket, the rendered criteria for a contract ticket,
   * null when the description carries no criteria at all.
   */
  acceptanceCriteria: string | null;
  /** True when any canonical contract heading was found (contract or legacy AC). */
  hasContractHeadings: boolean;
}

/**
 * Compile a ticket description into its execution contract. Throws
 * {@link ExecutionContractError} with an actionable message once any
 * contract-signal heading is present and the brief is ambiguous or malformed.
 * Never throws for a completely contract-free (legacy) description.
 */
export function compileExecutionContract(description: string | null | undefined): CompiledContract {
  if (!description?.trim()) {
    return { contract: null, acceptanceCriteria: null, hasContractHeadings: false };
  }
  const found = new Map<SectionKey, RawSection>();
  for (const section of splitSections(description)) {
    const key = CANONICAL_BY_NORMALIZED[normalizeHeadingName(section.name)];
    if (!key) continue;
    const prev = found.get(key);
    if (prev) {
      throw new ExecutionContractError(
        `duplicate \`## ${EXECUTION_CONTRACT_HEADINGS[key]}\` section — keep exactly one and move the extra content into it`
      );
    }
    found.set(key, { name: section.name, key, body: section.body });
  }
  if (found.size === 0) {
    return { contract: null, acceptanceCriteria: null, hasContractHeadings: false };
  }
  const hasSignal = SIGNAL_KEYS.some((key) => found.has(key));
  if (!hasSignal) {
    // `## Acceptance criteria` alone is the pre-contract Linear intake shape:
    // keep extracting its raw text exactly as before, without validation.
    const raw = found.get("acceptanceCriteria")!.body.trim();
    return { contract: null, acceptanceCriteria: raw || null, hasContractHeadings: true };
  }

  const modeSection = requireSection(found, "executionMode");
  const modeLines = modeSection.body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (modeLines.length !== 1) {
    throw new ExecutionContractError(
      `\`## Builder execution mode\` must state exactly one execution mode (got ${modeLines.length} non-empty lines)`
    );
  }
  const executionMode = normalizeExecutionMode(modeLines[0]!);
  if (!executionMode) {
    throw new ExecutionContractError(
      `unknown execution mode "${modeLines[0]}" — use exactly one of: ${EXECUTION_MODES.join(" | ")}`
    );
  }
  const nonGoals = parseNonGoals(requireSection(found, "nonGoals").body);
  const exitPredicate = parseExitPredicate(requireSection(found, "exitPredicate").body);
  const onePrStoppingPoint = parseOnePrStoppingPoint(requireSection(found, "onePrStoppingPoint").body);
  const acceptanceCriteria = parseAcceptanceCriteria(requireSection(found, "acceptanceCriteria").body);

  const contract: ExecutionContractV1 = {
    version: EXECUTION_CONTRACT_VERSION,
    executionMode,
    nonGoals,
    exitPredicate,
    onePrStoppingPoint,
    acceptanceCriteria,
  };
  return {
    contract,
    acceptanceCriteria: renderContractAcceptanceCriteria(contract),
    hasContractHeadings: true,
  };
}

/** True when the description carries any Planner-signal heading (a contract ticket). */
export function hasExecutionContractSignal(description: string | null | undefined): boolean {
  if (!description?.trim()) return false;
  for (const section of splitSections(description)) {
    const key = CANONICAL_BY_NORMALIZED[normalizeHeadingName(section.name)];
    if (key && (SIGNAL_KEYS as readonly string[]).includes(key)) return true;
  }
  return false;
}

/**
 * Resolve the issue-row fields derived from a ticket description: validate the
 * contract when signal headings are present (throws) and fill a missing
 * legacy acceptance-criteria value from the description. An explicitly
 * provided non-empty value always wins — the contract never silently drops it.
 */
export function resolveIssueContractFields(
  description: string | null | undefined,
  explicitAcceptanceCriteria: string | null | undefined
): { executionContract: ExecutionContractV1 | null; acceptanceCriteria: string | null } {
  const compiled = compileExecutionContract(description ?? null);
  const explicit = explicitAcceptanceCriteria?.trim() ? explicitAcceptanceCriteria : null;
  return {
    executionContract: compiled.contract,
    acceptanceCriteria: explicit ?? compiled.acceptanceCriteria ?? null,
  };
}

/** Best-effort contract for read paths — legacy/unparseable descriptions read as null. */
export function tryCompileContract(description: string | null | undefined): ExecutionContractV1 | null {
  try {
    return compileExecutionContract(description).contract;
  } catch {
    return null;
  }
}
