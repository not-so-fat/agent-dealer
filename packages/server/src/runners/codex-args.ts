export type CodexPhaseMode = "plan" | "execute" | "qa";

export type CodexSandboxMode = "read-only" | "workspace-write";

const FORBIDDEN_SANDBOX = "danger-full-access";
const FORBIDDEN_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
] as const;

/** Phase → sandbox. Never returns danger-full-access. */
export function codexSandboxForMode(mode: CodexPhaseMode): CodexSandboxMode {
  return mode === "execute" ? "workspace-write" : "read-only";
}

export interface BuildCodexExecArgsOpts {
  mode: CodexPhaseMode;
  workspaceRoot: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
  addDirs?: string[];
}

/**
 * Build `codex` argv for non-interactive exec.
 * Caller prepends nothing — pass these to spawn(resolveCodexBin(), args).
 */
export function buildCodexExecArgs(opts: BuildCodexExecArgsOpts): string[] {
  const sandbox = codexSandboxForMode(opts.mode);
  assertSafeSandbox(sandbox);

  const args: string[] = [
    "exec",
    "--json",
    "-C",
    opts.workspaceRoot,
    "-s",
    sandbox,
  ];

  if (opts.model) {
    args.push("-m", opts.model);
  }
  if (opts.outputSchemaPath) {
    args.push("--output-schema", opts.outputSchemaPath);
  }
  if (opts.outputLastMessagePath) {
    args.push("-o", opts.outputLastMessagePath);
  }
  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  // Prompt is user-controlled — do not include it in flag safety checks.
  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId, opts.prompt);
  } else {
    args.push(opts.prompt);
  }

  assertNoDangerFlags(args.slice(0, -1)); // exclude trailing prompt
  return args;
}

function assertSafeSandbox(sandbox: string): void {
  if (sandbox === FORBIDDEN_SANDBOX) {
    throw new Error("codex managed runner refused dangerous sandbox/bypass flags");
  }
}

/** Validate generated option tokens only — never the prompt string. */
function assertNoDangerFlags(generatedArgs: string[]): void {
  for (const token of generatedArgs) {
    if (token === FORBIDDEN_SANDBOX || (FORBIDDEN_FLAGS as readonly string[]).includes(token)) {
      throw new Error("codex managed runner refused dangerous sandbox/bypass flags");
    }
  }
}
