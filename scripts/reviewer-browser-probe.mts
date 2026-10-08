#!/usr/bin/env tsx
/**
 * NOT-380 operator probe: one reviewer-browser launch through Dealer's REAL
 * reviewer spawn path (detached-HEAD worktree at the pinned SHA, per-attempt
 * Agent Deck MCP config, `buildReviewerArgs` + `assertReviewerReadOnly` +
 * `realReviewerSpawn`) with a deterministic machine-readable manifest.
 *
 * STARTS A PAID REVIEWER SESSION (claude/codex/cursor) unless --dry-run is
 * passed. CI never runs this live; it refuses without REVIEWER_PROBE_LIVE=1.
 * --dry-run spawns nothing (no worktree, no deck, no CLI) and only prints the
 * exact bin/argv/policy the real path would use — safe anywhere.
 *
 *   # Launch evidence without spending a session:
 *   npx tsx scripts/reviewer-browser-probe.mts --dry-run --runtime claude_code --contract direct --head <40-hex>
 *
 *   # Live operator runs (exact commands for the PR body):
 *   REVIEWER_PROBE_LIVE=1 npx tsx scripts/reviewer-browser-probe.mts \
 *     --runtime claude_code --contract direct --repo /path/to/agent-dealer \
 *     --head <PR-head-SHA> --deck <deck-id> --out-dir docs/evaluations/not-380-reviewer-browser-manifests
 *   REVIEWER_PROBE_LIVE=1 npx tsx scripts/reviewer-browser-probe.mts \
 *     --runtime codex_local --contract direct --repo /path/to/agent-dealer \
 *     --head <PR-head-SHA> --deck <deck-id> --out-dir docs/evaluations/not-380-reviewer-browser-manifests
 *
 * Exit code is 0 whenever a manifest (or dry-run record) is written — the probe
 * outcome is data (`status` in the manifest), not a process failure. Exit 2
 * means the harness itself refused or errored before producing a manifest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roleCeiling } from "@agent-dealer/shared";
import {
  REVIEWER_BROWSER_VIEWPORTS,
  assertProbeLaunchReadOnly,
  buildReviewerBrowserProbePrompt,
  canonicalProbeJson,
  probeManifestFilename,
  resolveProbeArgv,
  resolveProbeBin,
  runReviewerBrowserProbe,
  sanitizeProbeManifest,
  type ReviewerBrowserProbeContract,
  type ReviewerBrowserProbeRuntime,
} from "../packages/server/src/coordinator/reviewer-browser-probe.js";

const RUNTIMES: ReviewerBrowserProbeRuntime[] = ["claude_code", "codex_local", "muse_code", "cursor_local"];
const CONTRACTS: ReviewerBrowserProbeContract[] = ["direct", "playwright-mcp", "coordinator-preview"];

function usage(): string {
  return [
    "Usage: reviewer-browser-probe.mts [options]",
    "",
    "  --runtime <claude_code|codex_local|muse_code|cursor_local>  (required)",
    "  --contract <direct|playwright-mcp|coordinator-preview>      (required)",
    "  --head <40-char hex SHA>            exact PR head to pin (required)",
    "  --repo <path>                      local git repo (live runs; default: cwd)",
    "  --deck <deck-id>                   Agent Deck id (live runs)",
    "  --model <id>                       runtime model override",
    "  --effort <low|medium|high>          reasoning effort override",
    "  --timeout-ms <n>                   reviewer wall clock (default: REVIEWER_TIMEOUT_MS)",
    "  --out-dir <dir>                    manifest directory (default: stdout only)",
    "  --app-route <path>                 mocks-free route (default: /issues)",
    "  --app-interaction <text>           required interaction state",
    "  --preview-url <url>                coordinator-preview: read-only preview URL",
    "  --preview-artifact <path>          coordinator-preview: artifact (repeatable)",
    "  --playwright-server <cmd...>       playwright-mcp: stdio server argv, e.g.",
    "                                     --playwright-server npx -- -y @playwright/mcp@1.2.3",
    "  --cancel-after-ms <n>              abort the spawn after n ms (cancellation control)",
    "  --no-sanitize                      keep absolute home paths (default: sanitize to ~)",
    "  --dry-run                          print exact launch only; spawn nothing",
    "  --help                             this text",
    "",
    "Live runs refuse without REVIEWER_PROBE_LIVE=1 (paid reviewer session).",
  ].join("\n");
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function flagValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) out.push(process.argv[i + 1]!);
  }
  return out;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** `--playwright-server a b c` captures argv until the next known flag or `--`. */
function playwrightServerArgv(): string[] | undefined {
  const i = process.argv.indexOf("--playwright-server");
  if (i === -1) return undefined;
  const argv: string[] = [];
  for (let j = i + 1; j < process.argv.length; j++) {
    const tok = process.argv[j]!;
    if (tok === "--") continue;
    if (tok.startsWith("--")) break;
    argv.push(tok);
  }
  return argv;
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }
  const dryRun = hasFlag("--dry-run");
  const runtime = flagValue("--runtime") as ReviewerBrowserProbeRuntime | undefined;
  const contract = flagValue("--contract") as ReviewerBrowserProbeContract | undefined;
  const head = flagValue("--head") ?? "";
  const repo = flagValue("--repo") ?? process.cwd();
  const deck = flagValue("--deck") ?? "";
  const model = flagValue("--model");
  const effort = flagValue("--effort") as "low" | "medium" | "high" | undefined;
  const timeoutMsRaw = flagValue("--timeout-ms");
  const outDir = flagValue("--out-dir");
  const appRoute = flagValue("--app-route") ?? "/issues";
  const appInteraction = flagValue("--app-interaction") ?? "open the first issue and expand its timeline";
  const previewUrl = flagValue("--preview-url") ?? null;
  const previewArtifacts = flagValues("--preview-artifact");
  const cancelAfterMsRaw = flagValue("--cancel-after-ms");
  const sanitize = !hasFlag("--no-sanitize");

  if (!runtime || !RUNTIMES.includes(runtime)) {
    console.error(`missing or invalid --runtime (want one of ${RUNTIMES.join(", ")})`);
    console.error(usage());
    process.exit(2);
  }
  if (!contract || !CONTRACTS.includes(contract)) {
    console.error(`missing or invalid --contract (want one of ${CONTRACTS.join(", ")})`);
    console.error(usage());
    process.exit(2);
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    console.error("missing or invalid --head (want a 40-char hex SHA)");
    console.error(usage());
    process.exit(2);
  }
  if (effort && !["low", "medium", "high"].includes(effort)) {
    console.error("invalid --effort (want low|medium|high)");
    process.exit(2);
  }
  const timeoutMs = timeoutMsRaw === undefined ? undefined : Number(timeoutMsRaw);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    console.error("invalid --timeout-ms (want a positive number)");
    process.exit(2);
  }
  const cancelAfterMs = cancelAfterMsRaw === undefined ? undefined : Number(cancelAfterMsRaw);
  if (cancelAfterMs !== undefined && (!Number.isFinite(cancelAfterMs) || cancelAfterMs <= 0)) {
    console.error("invalid --cancel-after-ms (want a positive number)");
    process.exit(2);
  }
  const playwrightArgv = playwrightServerArgv();
  if (contract === "playwright-mcp" && !dryRun && (!playwrightArgv || playwrightArgv.length === 0)) {
    console.error("playwright-mcp needs --playwright-server <cmd...> (evaluation-only; never a production default)");
    process.exit(2);
  }

  if (dryRun) {
    // No worktree, no deck, no CLI: the exact launch the real path would use.
    const bin = resolveProbeBin(runtime);
    const tempDir = "(probe temp dir, created at run time)";
    const prompt = buildReviewerBrowserProbePrompt({
      headSha: head,
      contract,
      runtime,
      tempDir,
      approvedRoots: [`${repo} (detached reviewer worktree at ${head.slice(0, 8)})`, tempDir],
      appRoute,
      appInteraction,
      previewUrl,
      previewArtifacts,
    });
    const mcpConfigPath =
      runtime === "codex_local"
        ? "(per-attempt CODEX_HOME dir)"
        : runtime === "cursor_local"
          ? "(in-worktree .cursor/mcp.json)"
          : runtime === "muse_code"
            ? null
            : "(per-attempt --mcp-config file)";
    let argv: string[];
    let preflight: string;
    try {
      argv = resolveProbeArgv({
        runtime,
        prompt,
        model,
        policy: roleCeiling("reviewer"),
        mcpConfigPath: mcpConfigPath ?? undefined,
        effort: effort ?? null,
      });
      // NOTE: the codex arm reads the real scoped config.toml, which does not
      // exist in a dry run — report the deckless shape (which carries
      // --ignore-user-config) as the preflight evidence instead of failing.
      const preflightArgv =
        runtime === "codex_local"
          ? resolveProbeArgv({ runtime, prompt, model, policy: roleCeiling("reviewer"), effort: effort ?? null })
          : argv;
      assertProbeLaunchReadOnly(
        preflightArgv,
        runtime === "codex_local" ? {} : { mcpConfigPath: mcpConfigPath ?? undefined }
      );
      preflight = "pass";
    } catch (err) {
      argv = runtime === "muse_code" ? ["(muse_code reviewer argv is not wired through buildReviewerArgs)"] : [];
      preflight = err instanceof Error ? `blocked: ${err.message}` : "blocked";
    }
    const record = {
      dryRun: true,
      runtime,
      contract,
      headSha: head,
      viewports: [...REVIEWER_BROWSER_VIEWPORTS],
      bin,
      argv,
      readOnlyPreflight: preflight,
      mcpConfigPath,
      promptSha256: (await import("node:crypto")).createHash("sha256").update(prompt, "utf8").digest("hex"),
      promptChars: prompt.length,
    };
    const bytes = canonicalProbeJson(record);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${runtime}.${contract}.dry-run.json`);
      fs.writeFileSync(file, bytes);
      console.log(`[reviewer-probe] dry-run record: ${file}`);
    } else {
      process.stdout.write(bytes);
    }
    return;
  }

  if (process.env.REVIEWER_PROBE_LIVE !== "1") {
    console.error("Refusing to run: this starts a paid reviewer session. Re-run with REVIEWER_PROBE_LIVE=1 (or --dry-run for launch evidence only).");
    process.exit(2);
  }
  if (!deck.trim()) {
    console.error("live runs need --deck <deck-id> (workers never start without one)");
    process.exit(2);
  }

  const controller = new AbortController();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  if (cancelAfterMs !== undefined) {
    cancelTimer = setTimeout(() => controller.abort(new Error(`--cancel-after-ms=${cancelAfterMs} elapsed`)), cancelAfterMs);
    cancelTimer.unref?.();
  }
  try {
    const manifest = await runReviewerBrowserProbe(
      {
        runtime,
        contract,
        repoPath: repo,
        headSha: head,
        deckId: deck,
        model,
        effort: effort ?? null,
        timeoutMs,
        appRoute,
        appInteraction,
        previewUrl,
        previewArtifacts,
        signal: controller.signal,
        playwrightServer: playwrightArgv ? { command: playwrightArgv[0]!, args: playwrightArgv.slice(1) } : undefined,
      },
      {}
    );
    const committed = sanitize ? sanitizeProbeManifest(manifest, os.homedir()) : manifest;
    const bytes = canonicalProbeJson(committed);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, probeManifestFilename(runtime, contract));
      fs.writeFileSync(file, bytes);
      console.log(`[reviewer-probe] status=${committed.status} reason=${committed.statusReason}`);
      console.log(`[reviewer-probe] manifest: ${file}`);
      console.log(`[reviewer-probe] sha256=${committed.verdictBinding.manifestSha256} head=${committed.headSha.slice(0, 12)}`);
    } else {
      process.stdout.write(bytes);
    }
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
  }
}

main().catch((err) => {
  console.error(`[reviewer-probe] ${(err as Error).message}`);
  process.exit(2);
});
