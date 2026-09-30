// packages/server/src/adapters/muse-visual-qa.ts
//
// NOT-303: Muse Dev visual-QA screenshot-path preflight.
//
// `Google Chrome.app` headless cannot run inside a Muse developer session: every
// launch aborts at macOS process registration
// (`TransformProcessType -> _RegisterApplication`, SIGABRT/exit 134, no output, no
// file) under the Muse sandbox, and `--no-sandbox` only disables Chrome's own
// sandbox so it cannot help. Evidence:
// `docs/evaluations/muse-code/chrome-headless-screenshot.md`.
//
// This module resolves, coordinator-side and before the session starts, which
// screenshot path a Muse developer worker gets. It never launches a browser and
// never touches the sandbox: the default verdict is unusable-with-reason (fail
// loud, so the worker reads it in its prompt instead of discovering the abort
// mid-session). Only an operator pre-installed non-AppKit headless shell,
// pointed at by `MUSE_HEADLESS_SHELL_BIN`, flips the verdict — the binary cannot
// be fetched in-session because the developer sandbox network is `restricted`.
//
// Deliberately NOT covered: widening the Muse sandbox, a coordinator-side
// screenshot step, and how Cursor/Claude/Codex workers run Chrome.
import fs from "node:fs";
import path from "node:path";

/** Operator override: absolute path to a pre-installed headless shell binary. */
export const MUSE_HEADLESS_SHELL_BIN_ENV = "MUSE_HEADLESS_SHELL_BIN";

/** Phase 1 evidence behind the default verdict. */
export const MUSE_VISUAL_QA_DOC = "docs/evaluations/muse-code/chrome-headless-screenshot.md";

/** The abort every `Google Chrome.app` headless launch dies with in-sandbox. */
export const MUSE_CHROME_APP_ABORT =
  "TransformProcessType -> _RegisterApplication (SIGABRT, exit 134)";

export interface MuseVisualQaStatus {
  /** True only when a pre-installed headless shell binary is configured and present. */
  usable: boolean;
  /** The binary the worker prompt names. Null when unusable. */
  binary: string | null;
  /** Suggested flags after the binary (`--screenshot=<png> <url>` shape). Empty when unusable. */
  args: string[];
  /** Human-readable verdict; the unusable reason names the abort and the missing binary. */
  reason: string;
}

export interface MuseVisualQaCheckOptions {
  env?: NodeJS.ProcessEnv;
  /** Filesystem probe; tests inject a stub, production uses `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Resolve the screenshot path for a Muse developer worker. Pure apart from the
 * injected `exists` probe; never spawns anything (probing `Google Chrome.app`
 * would only mint another crash report).
 */
export function checkMuseVisualQa(opts: MuseVisualQaCheckOptions = {}): MuseVisualQaStatus {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  const configured = env[MUSE_HEADLESS_SHELL_BIN_ENV]?.trim() || null;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      return {
        usable: false,
        binary: null,
        args: [],
        reason:
          `${MUSE_HEADLESS_SHELL_BIN_ENV} must be an absolute path (got a non-absolute value) — ` +
          `no headless shell configured, and Google Chrome.app headless aborts in-session ` +
          `(${MUSE_CHROME_APP_ABORT}); see ${MUSE_VISUAL_QA_DOC}`,
      };
    }
    if (!exists(configured)) {
      return {
        usable: false,
        binary: null,
        args: [],
        reason:
          `headless shell not found at ${MUSE_HEADLESS_SHELL_BIN_ENV} (${configured}) — ` +
          `no screenshot path is installed, and Google Chrome.app headless aborts in-session ` +
          `(${MUSE_CHROME_APP_ABORT}); see ${MUSE_VISUAL_QA_DOC}`,
      };
    }
    return {
      usable: true,
      binary: configured,
      args: ["--screenshot=<png>", "--window-size=1280,800"],
      reason: `pre-installed headless shell at ${configured}`,
    };
  }
  return {
    usable: false,
    binary: null,
    args: [],
    reason:
      `no headless shell installed (${MUSE_HEADLESS_SHELL_BIN_ENV} is unset — it must be ` +
      `pre-installed on the host because the developer sandbox network is restricted), and ` +
      `Google Chrome.app headless aborts in-session (${MUSE_CHROME_APP_ABORT}); ` +
      `see ${MUSE_VISUAL_QA_DOC}`,
  };
}

function chromeAppWarningLines(): string[] {
  return [
    `- Never launch \`Google Chrome.app\` headless here: every launch aborts at startup`,
    `  (${MUSE_CHROME_APP_ABORT}, no output, no file) under the Muse sandbox.`,
    `  \`--no-sandbox\` only disables Chrome's own sandbox and cannot help.`,
  ];
}

/**
 * Worker-prompt section for a Muse developer session. The unusable variant tells
 * the worker not to burn steps probing and to close with an explicit
 * `Visual QA: not run` conclusion line, so review evidence states it instead of
 * reading a missing screenshot as a pass.
 */
export function museVisualQaPromptSection(status: MuseVisualQaStatus): string[] {
  if (status.usable && status.binary) {
    return [
      `## Visual QA (screenshots)`,
      `A pre-installed headless shell is available: \`${status.binary}\`. For UI-visible`,
      `changes, capture a screenshot with`,
      `\`${status.binary} ${[...status.args, "<page-url>"].join(" ")}\``,
      `saving the PNG into the worktree, and commit it with your change.`,
      ...chromeAppWarningLines(),
      `End your implementation conclusion with a \`Visual QA:\` line —`,
      `\`Visual QA: verified (<png path>, exit <code>)\` or \`Visual QA: not run (<reason>)\`.`,
      ``,
    ];
  }
  return [
    `## Visual QA (screenshots)`,
    `Headless visual QA does not work inside this session — do not spend steps probing it:`,
    ...chromeAppWarningLines(),
    `- ${status.reason}`,
    `Visual QA is out of scope for this session: never read the absence of a screenshot as`,
    `a pass. End your implementation conclusion with a \`Visual QA:\` line —`,
    `\`Visual QA: not run (<short reason>)\` — so the review evidence states it explicitly.`,
    ``,
  ];
}
