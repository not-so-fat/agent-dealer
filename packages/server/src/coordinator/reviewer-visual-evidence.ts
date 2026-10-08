// packages/server/src/coordinator/reviewer-visual-evidence.ts
//
// NOT-384: SHA-bound CI visual artifacts for reviewers.
//
// NOT-380's split is a trusted job capturing screenshots and the read-only
// reviewer judging them. The trusted job is the CI `Visual` workflow (NOT-383),
// which uploads `ui-screenshots` (head captures), `ui-baseline` (base captures),
// and `ui-diff` (per-route/viewport pixel diffs plus a SUMMARY.md naming head
// and base SHAs) at the required 1440x900 and 390x800 viewports. This module is
// the reviewer-side consumer Dealer was missing:
//
//  1. `isUiAffectingChange` — a pure classifier over the head's changed files,
//     driven by the same path set as the `paths` filter in
//     `.github/workflows/visual.yml` (`VISUAL_WORKFLOW_PATHS`, defined once
//     here; a unit test pins it against the workflow file).
//  2. `classifyVisualEvidence` — a pure evidence classifier over a faked or
//     real workflow run plus the downloaded artifact names. A run for any
//     other SHA never counts.
//  3. `resolveReviewerVisualEvidence` — the async orchestration the reviewer
//     effect runs after CI is green: look up the Visual run for exactly the
//     head SHA through the `GithubAdapter`, download the three artifacts into
//     Dealer's issue-artifact storage, stage a read-only copy inside the
//     reviewer's worktree (outside tracked paths, ignored by `isWorktreeClean`),
//     and record one `visual_evidence` artifact row. It never throws: every
//     failure mode resolves to `missing` with a reason, and a missing or
//     failed capture never counts as a visual pass.
//  4. `readVisualEvidenceHold` — the merge-gate reader (auto-merge.ts): a
//     UI-affecting head whose recorded evidence is `missing` or `failed` holds
//     for `operator_verification` instead of merging or queuing a repair round.
//
// Reviewers gain no browser, shell, or write grant — they judge staged PNGs
// and the SUMMARY.md with the file tools they already have.
import fs from "node:fs";
import path from "node:path";
import { REVIEWER_VISUAL_STAGING_DIR_NAME } from "../adapters/git-worktree.js";
import type { GithubAdapter, WorkflowRunInfo } from "../adapters/github.js";
import { getVisualEvidenceDir } from "../paths.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";

/**
 * The path set that makes a head UI-affecting — the same list as the `paths`
 * filter in `.github/workflows/visual.yml` (both `pull_request` and `push`
 * blocks). Defined once here; `isUiAffectingChange` and the pinning unit test
 * both reference this constant, so a workflow edit without a classifier edit
 * (or vice versa) fails loudly.
 */
export const VISUAL_WORKFLOW_PATHS = [
  "apps/web/**",
  "packages/shared/**",
  "ui-screenshots.json",
  "scripts/ci-visual/**",
  ".github/workflows/visual.yml",
] as const;

/** The workflow file name as `gh run list --workflow` accepts it. */
export const VISUAL_WORKFLOW_FILE = "visual.yml";

/** The three artifacts NOT-383's `Visual` job uploads for every UI run. */
export const VISUAL_ARTIFACT_NAMES = ["ui-screenshots", "ui-baseline", "ui-diff"] as const;

export type VisualArtifactName = (typeof VISUAL_ARTIFACT_NAMES)[number];

/** Issue-artifact kind holding one recorded `VisualEvidenceRecord` per review. */
export const VISUAL_EVIDENCE_ARTIFACT_KIND = "visual_evidence";

/** Max SUMMARY.md characters embedded in the reviewer prompt. */
export const VISUAL_SUMMARY_MAX_CHARS = 4000;

/** Max staged file names listed per artifact in the reviewer prompt. */
export const VISUAL_FILE_LISTING_MAX_PER_ARTIFACT = 20;

function normalizeChangedPath(file: string): string {
  let out = file.trim();
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** GitHub `paths`-filter semantics for this module's small pattern set:
 * `dir/**` matches the dir itself and everything under it; anything else is
 * an exact repo-relative path. */
function visualPathMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return file === dir || file.startsWith(`${dir}/`);
  }
  return file === pattern;
}

/**
 * True when any changed file falls under `VISUAL_WORKFLOW_PATHS` — i.e. the
 * head is one the CI `Visual` workflow would capture. Pure.
 */
export function isUiAffectingChange(changedFiles: readonly string[]): boolean {
  for (const raw of changedFiles) {
    const file = normalizeChangedPath(raw);
    if (!file) continue;
    for (const pattern of VISUAL_WORKFLOW_PATHS) {
      if (visualPathMatches(pattern, file)) return true;
    }
  }
  return false;
}

export type VisualEvidenceState = "available" | "missing" | "failed" | "not_applicable";

/** Conclusions where the run completed and its captures are trustworthy. */
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Conclusions where the run reached a verdict and its captures are unusable. */
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/**
 * Classifies CI visual evidence for exactly `headSha`. Pure — the run and the
 * artifact names are inputs, so tests fake them.
 *
 * - `not_applicable`: the head is not UI-affecting (nothing to capture).
 * - `missing`: no run for this head, the run targets another SHA, the run has
 *   not completed, or a completed-successful run lacks any of the three
 *   artifacts. A stale-SHA run is never evidence, however green.
 * - `failed`: the run for this head completed with a failure conclusion.
 * - `available`: a completed-successful run for this head with all three
 *   artifacts present.
 */
export function classifyVisualEvidence(opts: {
  uiAffecting: boolean;
  headSha: string;
  run: WorkflowRunInfo | null;
  artifactNames: readonly string[];
}): VisualEvidenceState {
  if (!opts.uiAffecting) return "not_applicable";
  const run = opts.run;
  if (!run) return "missing";
  if (run.headSha !== opts.headSha) return "missing";
  const status = (run.status ?? "").toLowerCase();
  if (status !== "completed") return "missing";
  const conclusion = (run.conclusion ?? "").toLowerCase();
  if (FAILED_CONCLUSIONS.has(conclusion)) return "failed";
  if (!SUCCESS_CONCLUSIONS.has(conclusion)) return "missing";
  const present = new Set(opts.artifactNames);
  return VISUAL_ARTIFACT_NAMES.every((name) => present.has(name)) ? "available" : "missing";
}

/**
 * The GitHub surface `resolveReviewerVisualEvidence` needs. Production builds
 * one from the `GithubAdapter` (`githubVisualEvidenceFetcher`); tests inject a
 * fake that writes fixture files instead of shelling out to `gh`.
 */
export interface VisualEvidenceFetcher {
  /** The newest Visual run for exactly `headSha`, or null when the workflow
   * never ran for it. Must only ever return an exact-SHA run. */
  findRunForHead(opts: { cwd: string; headSha: string }): Promise<WorkflowRunInfo | null>;
  /** Downloads one artifact into `destDir` (files land directly inside it).
   * Throws when the artifact is absent or the download fails. */
  downloadArtifact(opts: { cwd: string; runId: number; name: string; destDir: string }): Promise<void>;
}

/**
 * Wraps the coordinator's existing GitHub access (`gh` via `GithubAdapter`).
 * Null when the adapter predates the NOT-384 methods — the caller records
 * `missing` (lookup unavailable), never "no run".
 */
export function githubVisualEvidenceFetcher(github: GithubAdapter): VisualEvidenceFetcher | null {
  const list = github.listWorkflowRunsForCommit?.bind(github);
  const download = github.downloadRunArtifact?.bind(github);
  if (!list || !download) return null;
  return {
    async findRunForHead({ cwd, headSha }) {
      const runs = await list({ cwd, workflow: VISUAL_WORKFLOW_FILE, commitSha: headSha });
      // `--commit` already filters server-side; re-verify client-side so a run
      // for any other SHA can never slip through.
      return runs.find((run) => run.headSha === headSha) ?? null;
    },
    async downloadArtifact({ cwd, runId, name, destDir }) {
      await download({ cwd, runId, name, destDir });
    },
  };
}

/** Dealer-owned bytes for one head's downloaded artifacts. */
export function visualEvidenceStoreDir(issueId: string, headSha: string): string {
  for (const part of [issueId, headSha]) {
    if (!part || part.includes("/") || part.includes("\\") || part === "." || part === "..") {
      throw new Error(`refusing to store visual evidence under unsafe path part: ${JSON.stringify(part)}`);
    }
  }
  const dir = path.join(getVisualEvidenceDir(), issueId, headSha);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The staging directory inside the reviewer worktree (see
 * `REVIEWER_VISUAL_STAGING_DIR_NAME`). */
export function reviewerVisualStagingDir(worktreePath: string): string {
  return path.join(worktreePath, REVIEWER_VISUAL_STAGING_DIR_NAME);
}

/** True when `dir` holds at least one regular file anywhere under it. Bounded
 * so a pathological tree cannot hang the check. */
function dirHasFiles(dir: string, budget = 5000): boolean {
  let remaining = budget;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (remaining-- <= 0) return true;
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return false;
}

/**
 * Canonical downloaded layout: `gh run download --name` extracts directly
 * into `destDir`, but if a nested `<destDir>/<name>/` directory holds files
 * instead (older `gh` layouts nest single artifacts), move them up so staging
 * and SUMMARY.md lookup see one shape.
 */
function normalizeDownloadedLayout(destDir: string, name: string): void {
  const nested = path.join(destDir, name);
  let nestedStat: fs.Stats;
  try {
    nestedStat = fs.statSync(nested);
  } catch {
    return;
  }
  if (!nestedStat.isDirectory()) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nested, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(destDir, entry.name);
    if (fs.existsSync(target)) continue;
    fs.renameSync(path.join(nested, entry.name), target);
  }
  try {
    fs.rmdirSync(nested);
  } catch {
    // a leftover nested dir is harmless — the files already moved up
  }
}

/** Sorted top-level file names under `dir` (bounded; "" when unreadable). */
function listTopLevelFiles(dir: string, limit: number): { files: string[]; total: number } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files: [], total: 0 };
  }
  const files = entries
    .filter((entry) => !entry.isSymbolicLink() && entry.isFile())
    .map((entry) => entry.name)
    .sort();
  return { files: files.slice(0, limit), total: files.length };
}

/**
 * Copies one downloaded artifact into the staging tree: directories 0755,
 * files 0444 (a read-only copy — the reviewer must judge it, never edit it).
 * Symlinks are never followed or recreated. Every destination is built from
 * `readdir` entry names, so nothing can escape `destRoot`.
 */
function copyTreeReadOnly(srcRoot: string, destRoot: string): void {
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o755 });
  const stack: Array<{ src: string; dest: string }> = [{ src: srcRoot, dest: destRoot }];
  while (stack.length > 0) {
    const { src, dest } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true, mode: 0o755 });
        stack.push({ src: srcPath, dest: destPath });
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        fs.chmodSync(destPath, 0o444);
      }
    }
  }
}

export interface StagedVisualPaths {
  stagedDir: string;
  screenshotsDir: string;
  baselineDir: string;
  diffDir: string;
  /** Staged `SUMMARY.md` path, or null when the diff artifact lacks one. */
  summaryPath: string | null;
}

/**
 * Stages the three downloaded artifacts as a read-only copy under
 * `<worktree>/.agent-dealer-visual/` (outside tracked paths, ignored by
 * `isWorktreeClean`). Idempotent — an existing staging dir is replaced.
 */
export function stageVisualArtifacts(opts: { worktreePath: string; storeDir: string }): StagedVisualPaths {
  const stagedDir = reviewerVisualStagingDir(opts.worktreePath);
  fs.rmSync(stagedDir, { recursive: true, force: true });
  fs.mkdirSync(stagedDir, { recursive: true, mode: 0o755 });
  const screenshotsDir = path.join(stagedDir, "ui-screenshots");
  const baselineDir = path.join(stagedDir, "ui-baseline");
  const diffDir = path.join(stagedDir, "ui-diff");
  copyTreeReadOnly(path.join(opts.storeDir, "ui-screenshots"), screenshotsDir);
  copyTreeReadOnly(path.join(opts.storeDir, "ui-baseline"), baselineDir);
  copyTreeReadOnly(path.join(opts.storeDir, "ui-diff"), diffDir);
  const summaryPath = path.join(diffDir, "SUMMARY.md");
  return {
    stagedDir,
    screenshotsDir,
    baselineDir,
    diffDir,
    summaryPath: fs.existsSync(summaryPath) ? summaryPath : null,
  };
}

/** Removes the staging directory (best-effort; absent is fine). Called before
 * worktree removal so no residue survives the attempt even if that fails. */
export function cleanupStagedVisualArtifacts(worktreePath: string): void {
  fs.rmSync(reviewerVisualStagingDir(worktreePath), { recursive: true, force: true });
}

/** Bounded `SUMMARY.md` text, or null when the file is absent/unreadable. */
export function readVisualDiffSummary(
  stagedDiffDir: string,
  maxChars: number = VISUAL_SUMMARY_MAX_CHARS
): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(stagedDiffDir, "SUMMARY.md"), "utf8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n… (truncated, full file in the staged ui-diff directory)`;
}

/** The stored `visual_evidence` artifact content for one reviewed head. */
export interface VisualEvidenceRecord {
  headSha: string;
  baseSha: string;
  uiAffecting: boolean;
  state: VisualEvidenceState;
  runId: number | null;
  artifactNames: string[];
  stagedDir: string | null;
  summaryChars: number | null;
  reason: string | null;
}

export interface ResolvedReviewerVisualEvidence extends VisualEvidenceRecord {
  /** Staged artifact paths (only when `state` is `available`). */
  staged: StagedVisualPaths | null;
  /** Bounded SUMMARY.md text (only when `available` and the file staged). */
  summary: string | null;
  /** Sorted top-level file names per staged artifact (only when `available`). */
  files: Record<VisualArtifactName, { files: string[]; total: number }> | null;
}

function truncateReason(text: string, maxChars = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars).trimEnd()}…` : oneLine;
}

function noEvidence(uiAffecting: boolean, base: Omit<VisualEvidenceRecord, "uiAffecting" | "state" | "runId" | "artifactNames" | "stagedDir" | "summaryChars" | "reason">, reason: string): ResolvedReviewerVisualEvidence {
  return {
    ...base,
    uiAffecting,
    state: "missing",
    runId: null,
    artifactNames: [],
    stagedDir: null,
    summaryChars: null,
    reason,
    staged: null,
    summary: null,
    files: null,
  };
}

/**
 * Resolves CI visual evidence for one reviewer attempt (runs after CI is
 * green): classify the head, look up the Visual run for exactly the head SHA,
 * download the artifacts into Dealer storage, stage them read-only in the
 * worktree when usable, and record one `visual_evidence` artifact row.
 *
 * Never throws and never returns usable evidence it does not have: unknown
 * changed files fail closed to UI-affecting + `missing`, and every lookup,
 * download, stage, or record failure degrades to `missing` with a reason.
 */
export async function resolveReviewerVisualEvidence(opts: {
  issueId: string;
  workerSessionId?: string | null;
  worktreePath: string;
  baseSha: string;
  headSha: string;
  /** Null when the changed-file list itself could not be computed. */
  changedFiles: readonly string[] | null;
  github: GithubAdapter;
  /** Test seam — defaults to the `GithubAdapter`-backed fetcher. */
  fetcher?: VisualEvidenceFetcher | null;
}): Promise<ResolvedReviewerVisualEvidence> {
  const base = { headSha: opts.headSha, baseSha: opts.baseSha };
  const record = (content: VisualEvidenceRecord, blobPath: string | null): void => {
    try {
      createIssueArtifact({
        issueId: opts.issueId,
        workerSessionId: opts.workerSessionId ?? null,
        kind: VISUAL_EVIDENCE_ARTIFACT_KIND,
        content,
        blobPath,
        author: "system",
      });
    } catch (err) {
      console.error("[coordinator] visual evidence record failed", { issueId: opts.issueId, err });
    }
  };
  try {
    const uiAffecting =
      opts.changedFiles === null ? true : isUiAffectingChange(opts.changedFiles);
    if (!uiAffecting) {
      const resolved: ResolvedReviewerVisualEvidence = {
        ...base,
        uiAffecting,
        state: "not_applicable",
        runId: null,
        artifactNames: [],
        stagedDir: null,
        summaryChars: null,
        reason: "head touches none of the Visual workflow paths",
        staged: null,
        summary: null,
        files: null,
      };
      record(resolved, null);
      return resolved;
    }
    if (opts.changedFiles === null) {
      const resolved = noEvidence(
        true,
        base,
        "changed-file list unavailable — treating the head as UI-affecting without evidence"
      );
      record(resolved, null);
      return resolved;
    }
    const fetcher = opts.fetcher ?? githubVisualEvidenceFetcher(opts.github);
    if (!fetcher) {
      const resolved = noEvidence(
        true,
        base,
        "Visual run lookup is unavailable through the configured GitHub access"
      );
      record(resolved, null);
      return resolved;
    }
    let run: WorkflowRunInfo | null;
    try {
      run = await fetcher.findRunForHead({ cwd: opts.worktreePath, headSha: opts.headSha });
    } catch (err) {
      const resolved = noEvidence(
        true,
        base,
        `Visual run lookup failed: ${truncateReason(err instanceof Error ? err.message : String(err))}`
      );
      record(resolved, null);
      return resolved;
    }
    if (!run || run.headSha !== opts.headSha) {
      const resolved = noEvidence(
        true,
        base,
        run
          ? `newest Visual run targets ${run.headSha.slice(0, 8)} instead of this head — a run for another SHA never counts`
          : `no Visual workflow run found for head ${opts.headSha.slice(0, 8)} (the workflow may not have run for this push)`
      );
      resolved.runId = run?.databaseId ?? null;
      record(resolved, null);
      return resolved;
    }
    const status = (run.status ?? "").toLowerCase();
    const conclusion = (run.conclusion ?? "").toLowerCase();
    if (status !== "completed" || !SUCCESS_CONCLUSIONS.has(conclusion)) {
      const state: VisualEvidenceState =
        status === "completed" && FAILED_CONCLUSIONS.has(conclusion) ? "failed" : "missing";
      const reason =
        state === "failed"
          ? `Visual run ${run.databaseId} for this head concluded ${conclusion || "without a conclusion"} — its captures are unusable`
          : status !== "completed"
            ? `Visual run ${run.databaseId} for this head has not completed (status ${status || "unknown"})`
            : `Visual run ${run.databaseId} for this head concluded ${conclusion || "without a conclusion"} — not a usable success`;
      const resolved: ResolvedReviewerVisualEvidence = {
        ...base,
        uiAffecting: true,
        state,
        runId: run.databaseId,
        artifactNames: [],
        stagedDir: null,
        summaryChars: null,
        reason,
        staged: null,
        summary: null,
        files: null,
      };
      record(resolved, null);
      return resolved;
    }
    // Completed + successful: the downloads themselves are the artifact
    // presence check (a missing artifact fails its download).
    const storeDir = visualEvidenceStoreDir(opts.issueId, opts.headSha);
    const downloaded: string[] = [];
    for (const name of VISUAL_ARTIFACT_NAMES) {
      const destDir = path.join(storeDir, name);
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        await fetcher.downloadArtifact({ cwd: opts.worktreePath, runId: run.databaseId, name, destDir });
        normalizeDownloadedLayout(destDir, name);
        if (dirHasFiles(destDir)) downloaded.push(name);
      } catch {
        // per-artifact failure only marks that artifact absent
      }
    }
    const state = classifyVisualEvidence({
      uiAffecting: true,
      headSha: opts.headSha,
      run,
      artifactNames: downloaded,
    });
    if (state !== "available") {
      const absent = VISUAL_ARTIFACT_NAMES.filter((name) => !downloaded.includes(name));
      const resolved: ResolvedReviewerVisualEvidence = {
        ...base,
        uiAffecting: true,
        state,
        runId: run.databaseId,
        artifactNames: downloaded,
        stagedDir: null,
        summaryChars: null,
        reason: `Visual run ${run.databaseId} for this head is missing usable artifacts: ${absent.join(", ")}`,
        staged: null,
        summary: null,
        files: null,
      };
      record(resolved, storeDir);
      return resolved;
    }
    let staged: StagedVisualPaths;
    try {
      staged = stageVisualArtifacts({ worktreePath: opts.worktreePath, storeDir });
    } catch (err) {
      const resolved: ResolvedReviewerVisualEvidence = {
        ...base,
        uiAffecting: true,
        state: "missing",
        runId: run.databaseId,
        artifactNames: downloaded,
        stagedDir: null,
        summaryChars: null,
        reason: `Visual run ${run.databaseId} artifacts downloaded but could not be staged for the reviewer: ${truncateReason(err instanceof Error ? err.message : String(err))}`,
        staged: null,
        summary: null,
        files: null,
      };
      record(resolved, storeDir);
      return resolved;
    }
    const summary = readVisualDiffSummary(staged.diffDir);
    const files: Record<VisualArtifactName, { files: string[]; total: number }> = {
      "ui-screenshots": listTopLevelFiles(staged.screenshotsDir, VISUAL_FILE_LISTING_MAX_PER_ARTIFACT),
      "ui-baseline": listTopLevelFiles(staged.baselineDir, VISUAL_FILE_LISTING_MAX_PER_ARTIFACT),
      "ui-diff": listTopLevelFiles(staged.diffDir, VISUAL_FILE_LISTING_MAX_PER_ARTIFACT),
    };
    const resolved: ResolvedReviewerVisualEvidence = {
      ...base,
      uiAffecting: true,
      state: "available",
      runId: run.databaseId,
      artifactNames: downloaded,
      stagedDir: staged.stagedDir,
      summaryChars: summary?.length ?? null,
      reason: null,
      staged,
      summary,
      files,
    };
    record(resolved, storeDir);
    return resolved;
  } catch (err) {
    // Truly unexpected (store dir, record shape) — still `missing`, never a pass.
    const resolved = noEvidence(
      true,
      base,
      `visual evidence resolution failed: ${truncateReason(err instanceof Error ? err.message : String(err))}`
    );
    record(resolved, null);
    return resolved;
  }
}

/** The reviewer-prompt shape. `not_applicable` maps to `undefined` (no section). */
export interface ReviewerVisualEvidenceInput {
  state: "available" | "missing" | "failed";
  headSha: string;
  baseSha: string;
  runId: number | null;
  staged: StagedVisualPaths | null;
  summary: string | null;
  files: Record<VisualArtifactName, { files: string[]; total: number }> | null;
  reason: string | null;
}

export function toReviewerVisualEvidenceInput(
  resolved: ResolvedReviewerVisualEvidence
): ReviewerVisualEvidenceInput | undefined {
  if (resolved.state === "not_applicable") return undefined;
  return {
    state: resolved.state,
    headSha: resolved.headSha,
    baseSha: resolved.baseSha,
    runId: resolved.runId,
    staged: resolved.staged,
    summary: resolved.summary,
    files: resolved.files,
    reason: resolved.reason,
  };
}

/** What the merge gate holds on: a UI-affecting head without usable evidence. */
export interface VisualEvidenceHold {
  state: "missing" | "failed";
  headSha: string;
  reason: string;
  runId: number | null;
  /** Artifact names with no usable captures (named in the operator action). */
  missingArtifacts: string[];
}

interface StoredVisualEvidenceRecord {
  headSha?: unknown;
  uiAffecting?: unknown;
  state?: unknown;
  reason?: unknown;
  runId?: unknown;
  artifactNames?: unknown;
}

/**
 * Reads the latest recorded evidence for `headSha`: non-null exactly when the
 * head is UI-affecting and its recorded state is `missing` or `failed`. A
 * record for any other head, an unreadable record, or no record at all means
 * no hold (reviewer sessions always record before a verdict can approve, so a
 * missing record means no review ran — not missing evidence).
 */
export function readVisualEvidenceHold(issueId: string, headSha: string): VisualEvidenceHold | null {
  if (!headSha) return null;
  const artifact = latestIssueArtifact(issueId, VISUAL_EVIDENCE_ARTIFACT_KIND);
  if (!artifact?.contentJson) return null;
  let stored: StoredVisualEvidenceRecord;
  try {
    stored = JSON.parse(artifact.contentJson) as StoredVisualEvidenceRecord;
  } catch {
    return null;
  }
  if (stored.headSha !== headSha) return null;
  if (stored.uiAffecting !== true) return null;
  if (stored.state !== "missing" && stored.state !== "failed") return null;
  const present = new Set(Array.isArray(stored.artifactNames) ? stored.artifactNames.filter((n): n is string => typeof n === "string") : []);
  const missingArtifacts =
    stored.state === "failed"
      ? [...VISUAL_ARTIFACT_NAMES]
      : VISUAL_ARTIFACT_NAMES.filter((name) => !present.has(name));
  return {
    state: stored.state,
    headSha,
    reason: typeof stored.reason === "string" && stored.reason ? stored.reason : "no usable CI visual captures",
    runId: typeof stored.runId === "number" ? stored.runId : null,
    missingArtifacts: missingArtifacts.length > 0 ? missingArtifacts : [...VISUAL_ARTIFACT_NAMES],
  };
}
