// NOT-179: developer-role argv for native Muse Code (`muse exec --json`), from the NOT-177 pinned
// contract (docs/evaluations/muse-code/headless-contract.md, "Command contract"). Pure: no spawn,
// no per-attempt XDG dirs, no settings.json — those belong to the coordinator wiring (NOT-181).
// Reviewer argv, resume and cancellation are out of scope.

export const MUSE_COMMAND = "muse";

/**
 * NOT-316: what the Muse developer sandbox cannot do, derived from the real
 * launch flags in `buildMuseDeveloperInvocation` below. The developer prompt's
 * "Environment limits" section is rendered from this constant (not hand-written
 * prose), and `muse-code-args.test.ts` asserts the pairing — changing
 * `--sandbox-network` without updating this constant fails a test.
 *
 * Live probe results behind these values: under `restricted` there is no DNS
 * (npm registry and GitHub API unreachable) and loopback `listen()` fails with
 * EPERM; under `proxy-only` network works through a local proxy but `listen()`
 * still fails; under `enabled` both work. No headless browser or
 * credentials/Keychain are provisioned into the developer session.
 */
export const MUSE_SANDBOX_CAPABILITIES = {
  /** Must equal the `--sandbox-network` value passed in the developer argv. */
  sandboxNetwork: "restricted",
  /** Effective network access under that sandbox mode. */
  network: "none",
  /** Whether loopback `listen()` works. */
  loopbackListen: false,
  /** Whether a browser is available for visual QA / screenshots. */
  browser: false,
  /** Whether credentials / Keychain are provisioned. */
  credentialsKeychain: false,
} as const;

/** The launcher re-execs a newer binary hourly unless this is set, so the pinned version can drift. */
export const MUSE_NO_AUTO_UPDATE_ENV = { MUSE_NO_AUTO_UPDATE: "1" } as const;

export interface MuseDeveloperOptions {
  /** Explicit model id. Omitting `--model` changes the reported profile, so it is never optional. */
  model: string;
  maxModelSteps: number;
  /** Caller-chosen UUID; it names the on-disk session log that carries usage and the confirmed model. */
  sessionId: string;
  prompt: string;
}

export interface MuseInvocation {
  command: typeof MUSE_COMMAND;
  args: string[];
  env: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Developer posture: approvals never (never prompts), sandbox left on with network `restricted`
 * (the default is `proxy-only`), web tools off, foreign personal context off. Deliberately absent:
 * `--yolo`, `--disable-sandbox`, `--disable-approval`, `--trust-workspace`, `-w/--worktree`,
 * `--preset`, `--agents`.
 */
export function buildMuseDeveloperInvocation(opts: MuseDeveloperOptions): MuseInvocation {
  if (!opts.model.trim()) throw new Error("muse: model must be set explicitly");
  if (!Number.isInteger(opts.maxModelSteps) || opts.maxModelSteps < 1) {
    throw new Error("muse: maxModelSteps must be a positive integer");
  }
  if (!UUID_RE.test(opts.sessionId)) throw new Error("muse: sessionId must be a UUID");
  if (!opts.prompt.trim()) throw new Error("muse: prompt must not be empty");
  // The prompt is the positional argument; a leading dash would be read as a flag, and `--` handling
  // was not probed in NOT-177.
  if (opts.prompt.startsWith("-")) throw new Error("muse: prompt must not start with '-'");

  return {
    command: MUSE_COMMAND,
    args: [
      "exec",
      "--json",
      "--no-foreign-personal-context",
      "--model",
      opts.model,
      "--approval-mode",
      "never",
      "--approval-judge",
      "off",
      "--sandbox-network",
      "restricted",
      "--disable-web-tools",
      "--session-id",
      opts.sessionId,
      "--max-model-steps",
      String(opts.maxModelSteps),
      opts.prompt,
    ],
    env: { ...MUSE_NO_AUTO_UPDATE_ENV },
  };
}
