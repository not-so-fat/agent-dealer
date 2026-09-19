import fs from "node:fs";
import path from "node:path";
import type { OutboundToolCall, DeckAccessErrorCode } from "@agent-dealer/shared";
import type { ReflectProposal } from "@agent-dealer/shared";
import { getAgentDeckConfig } from "../repository/intake-settings.js";

export function getAgentDeckApiUrl(): string {
  if (process.env.AGENT_DECK_API_URL) {
    return process.env.AGENT_DECK_API_URL.replace(/\/$/, "");
  }
  const cfg = getAgentDeckConfig();
  return `http://${cfg.host}:${cfg.port}`;
}

export function getAgentDeckMcpUrl(): string {
  if (process.env.AGENT_DECK_API_URL) {
    const api = getAgentDeckApiUrl();
    try {
      const u = new URL(api);
      const mcpPort = Number(u.port) - 1;
      return `${u.protocol}//${u.hostname}:${mcpPort}`;
    } catch {
      return "http://127.0.0.1:1110";
    }
  }
  const cfg = getAgentDeckConfig();
  return `http://${cfg.host}:${cfg.port - 1}`;
}

export async function checkAgentDeckHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getAgentDeckApiUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testAgentDeckConnection(): Promise<{
  connected: boolean;
  apiUrl: string;
  mcpUrl: string;
  deckCount?: number;
  envOverride: boolean;
  error?: string;
  deckAccessError?: DeckAccessErrorCode;
  deckAccessErrorMessage?: string;
}> {
  const apiUrl = getAgentDeckApiUrl();
  const mcpUrl = getAgentDeckMcpUrl();
  const envOverride = Boolean(process.env.AGENT_DECK_API_URL);

  try {
    const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) {
      return {
        connected: false,
        apiUrl,
        mcpUrl,
        envOverride,
        error: `HTTP ${health.status}`,
      };
    }
    const decksResult = await fetchDecks();
    if (decksResult.ok) {
      return { connected: true, apiUrl, mcpUrl, deckCount: decksResult.decks.length, envOverride };
    }
    return {
      connected: true,
      apiUrl,
      mcpUrl,
      envOverride,
      deckAccessError: decksResult.code,
      deckAccessErrorMessage: decksResult.message,
    };
  } catch (e) {
    return {
      connected: false,
      apiUrl,
      mcpUrl,
      envOverride,
      error: String(e),
    };
  }
}

export type DeckAccessResult =
  | { ok: true; decks: Array<{ id: string; name: string }> }
  | { ok: false; code: DeckAccessErrorCode; message: string };

/**
 * Unauthenticated launch deck-metadata discovery (NOT-106) — `GET /api/launch/decks`.
 * A network/parse failure is reported as a typed outcome, never as an empty deck list.
 */
export async function fetchDecks(): Promise<DeckAccessResult> {
  try {
    const res = await fetch(`${getAgentDeckApiUrl()}/api/launch/decks`, {
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: { decks?: Array<{ id: string; name: string }> }; message?: string }
      | null;
    if (!res.ok || !json || json.success === false) {
      return {
        ok: false,
        code: "DECK_UNAVAILABLE",
        message: json?.message ?? `Agent Deck API error: ${res.status}`,
      };
    }
    return { ok: true, decks: json.data?.decks ?? [] };
  } catch (e) {
    return { ok: false, code: "DECK_UNAVAILABLE", message: String(e) };
  }
}

/** @deprecated Prefer `fetchDecks` — alias kept for existing call sites. */
export const fetchAuthorizedDecks = fetchDecks;

const DASHBOARD_HEADERS = { "x-agent-deck-client": "dashboard" };
const DEALER_HEADERS = { "x-agent-deck-client": "dealer" };

export async function proposePlaybookPatch(
  deckId: string,
  runId: string,
  proposal: ReflectProposal & { playbook_id: string }
): Promise<{ id: string; playbookId: string | null }> {
  const res = await fetch(`${getAgentDeckApiUrl()}/api/playbook-patches`, {
    method: "POST",
    headers: {
      ...DEALER_HEADERS,
      "Content-Type": "application/json",
      "x-agent-deck-deck-id": deckId,
      "x-agent-deck-source-ref": runId,
    },
    body: JSON.stringify({
      kind: "update",
      playbook_id: proposal.playbook_id,
      ops: proposal.ops,
      rationale: proposal.rationale,
      evidence: proposal.evidence,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Agent Deck patch propose failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    success?: boolean;
    data?: { id: string; playbookId: string | null };
  };
  if (!json.data?.id) throw new Error("Playbook patch propose failed");
  return json.data;
}

export function agentDeckPatchesUrl(): string {
  return `${getAgentDeckApiUrl()}/playbook-patches`;
}

export async function fetchPlaybook(playbookId: string): Promise<{ id: string; title: string; body: string }> {
  const res = await fetch(`${getAgentDeckApiUrl()}/api/playbooks/${playbookId}`, {
    headers: DASHBOARD_HEADERS,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Agent Deck playbook fetch failed: ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: { id: string; title: string; body: string } };
  if (!json.data) throw new Error("Playbook not found");
  return json.data;
}

export async function updatePlaybookBody(
  playbookId: string,
  body: string
): Promise<{ id: string; title: string; body: string }> {
  const res = await fetch(`${getAgentDeckApiUrl()}/api/playbooks/${playbookId}`, {
    method: "PUT",
    headers: { ...DASHBOARD_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Agent Deck playbook update failed: ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: { id: string; title: string; body: string } };
  if (!json.data) throw new Error("Playbook update failed");
  return json.data;
}

export function readClaudeMcpConfigPath(): string {
  return process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");
}

type ClaudeMcpServerEntry = {
  url?: string;
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Outcome of probing Claude's Agent Deck MCP registration (HTTP url or stdio mcp-launch). */
export type AgentDeckMcpRegistration =
  | { status: "registered" }
  | { status: "missing" }
  | {
      status: "endpoint_mismatch";
      expectedHost: string;
      expectedPort: string;
      foundHost: string;
      foundPort: string;
    };

function expectedAgentDeckMcpEndpoint(): { hostname: string; port: string } {
  const expected = new URL(getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "") + "/mcp");
  const port = expected.port || (expected.protocol === "https:" ? "443" : "80");
  return { hostname: expected.hostname, port };
}

function isAgentDeckMcpServerName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("agent-deck") || name === "agent-deck";
}

/** Basename of `agent-deck` (PATH lookup or absolute install path). */
function commandInvokesAgentDeck(command: string | undefined): boolean {
  if (!command?.trim()) return false;
  const base = path.basename(command.trim()).replace(/\.(cmd|exe|bat)$/i, "");
  return base === "agent-deck";
}

function argsIncludeMcpLaunch(args: unknown): boolean {
  return Array.isArray(args) && args.some((a) => a === "mcp-launch");
}

/**
 * Classify Claude MCP config for Agent Deck.
 * Accepts legacy HTTP `url` entries and current `agent-deck mcp-launch` stdio + env ports
 * from `agent-deck setup --client claude`.
 */
export function checkAgentDeckMcpRegistration(): AgentDeckMcpRegistration {
  try {
    const configPath = readClaudeMcpConfigPath();
    if (!fs.existsSync(configPath)) return { status: "missing" };
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as { mcpServers?: Record<string, ClaudeMcpServerEntry> };
    const expected = expectedAgentDeckMcpEndpoint();
    let mismatch: Extract<AgentDeckMcpRegistration, { status: "endpoint_mismatch" }> | null = null;

    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (!isAgentDeckMcpServerName(name)) continue;

      if (server.url) {
        try {
          const u = new URL(server.url);
          const foundPort = u.port || (u.protocol === "https:" ? "443" : "80");
          if (u.hostname === expected.hostname && foundPort === expected.port) {
            return { status: "registered" };
          }
          mismatch = {
            status: "endpoint_mismatch",
            expectedHost: expected.hostname,
            expectedPort: expected.port,
            foundHost: u.hostname,
            foundPort,
          };
        } catch {
          // skip invalid url
        }
        continue;
      }

      // Current Claude setup: stdio `agent-deck mcp-launch` with AGENT_DECK_* env.
      if (commandInvokesAgentDeck(server.command) && argsIncludeMcpLaunch(server.args)) {
        const foundHost = server.env?.AGENT_DECK_HOST?.trim() || "127.0.0.1";
        const foundPort = server.env?.AGENT_DECK_MCP_PORT?.trim() ?? "";
        if (foundHost === expected.hostname && foundPort === expected.port) {
          return { status: "registered" };
        }
        mismatch = {
          status: "endpoint_mismatch",
          expectedHost: expected.hostname,
          expectedPort: expected.port,
          foundHost,
          foundPort: foundPort || "(missing)",
        };
      }
    }

    if (mismatch) return mismatch;
    return { status: "missing" };
  } catch {
    return { status: "missing" };
  }
}

export function isAgentDeckMcpRegistered(): boolean {
  return checkAgentDeckMcpRegistration().status === "registered";
}

export type CallServiceToolPayload = {
  serviceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

/** Map PRD toolCall to deck MCP call_service_tool args (serviceName → serviceId). */
export function toCallServiceToolPayload(toolCall: OutboundToolCall): CallServiceToolPayload {
  return {
    serviceId: toolCall.serviceName,
    toolName: toolCall.toolName,
    arguments: toolCall.arguments as Record<string, unknown>,
  };
}

export function extractPermalink(toolResult: unknown): string | undefined {
  if (!toolResult || typeof toolResult !== "object") return undefined;
  const content = (toolResult as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block.type !== "text" || !block.text) continue;
    try {
      const parsed = JSON.parse(block.text) as { permalink?: string };
      if (parsed.permalink) return parsed.permalink;
    } catch {
      const m = block.text.match(/https?:\/\/\S+/);
      if (m) return m[0];
    }
  }
  return undefined;
}

/** Parse Agent Deck call_service_tool MCP result — throws on proxy- or Slack-reported failure. */
export function assertCallServiceToolSuccess(toolResult: unknown): void {
  const err = findCallServiceToolError(toolResult);
  if (err) throw new Error(err);
}

function findCallServiceToolError(toolResult: unknown, depth = 0): string | undefined {
  if (!toolResult || typeof toolResult !== "object" || depth > 4) return undefined;
  const tr = toolResult as {
    isError?: boolean;
    success?: boolean;
    error?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (tr.isError) {
    const text = formatToolResultText(tr) ?? "call_service_tool failed";
    const nested = parseNestedCallServiceToolError(text, depth);
    if (nested) return nested;
    return summarizeToolErrorText(text) ?? text.slice(0, 500);
  }
  if (tr.success === false) {
    return tr.error ?? "call_service_tool failed";
  }
  const text = formatToolResultText(tr);
  if (text) {
    const nested = parseNestedCallServiceToolError(text, depth);
    if (nested) return nested;
    const plain = summarizeToolErrorText(text);
    if (plain) return plain;
  }
  return undefined;
}

function parseNestedCallServiceToolError(text: string, depth: number): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return findCallServiceToolError(parsed, depth + 1);
  } catch {
    return undefined;
  }
}

const SLACK_ERROR_RE =
  /channel_not_found|not_in_channel|missing_scope|invalid_auth|user_not_found|cannot_dm|is_archived/i;

function summarizeToolErrorText(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;

  try {
    const parsed = JSON.parse(t) as { error?: string; message?: string };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // not top-level JSON — fall through
  }

  if (SLACK_ERROR_RE.test(t)) {
    const line = t.split("\n").find((l) => SLACK_ERROR_RE.test(l));
    if (line?.trim()) return line.trim().slice(0, 500);
    const match = t.match(SLACK_ERROR_RE);
    if (match) return match[0];
  }

  if (/"success"\s*:\s*false/i.test(t)) {
    try {
      const parsed = JSON.parse(t) as { error?: string };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // ignore
    }
  }

  return undefined;
}

function formatToolResultText(tr: { content?: Array<{ type?: string; text?: string }> }): string | undefined {
  if (!Array.isArray(tr.content)) return undefined;
  return tr.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim() || undefined;
}

// `deliverOutboundDraft` (deck-header MCP call for approved outbound delivery) has moved to
// ./outbound-delivery.ts (NOT-106 / NOT-95).
