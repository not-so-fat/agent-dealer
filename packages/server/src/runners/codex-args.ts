export type CodexPhaseMode = "plan" | "execute" | "qa";

export type CodexSandboxMode = "read-only" | "workspace-write";

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

  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId, opts.prompt);
  } else {
    args.push(opts.prompt);
  }

  assertNoDangerFlags(args);
  return args;
}

function assertNoDangerFlags(args: string[]): void {
  const joined = args.join(" ");
  if (
    joined.includes("danger-full-access") ||
    joined.includes("dangerously-bypass-approvals-and-sandbox") ||
    joined.includes("dangerously-bypass-hook-trust")
  ) {
    throw new Error("codex managed runner refused dangerous sandbox/bypass flags");
  }
}
