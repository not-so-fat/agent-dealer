import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OutboundToolCall } from "@agent-dealer/shared";
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
    let deckCount: number | undefined;
    try {
      const decksRes = await fetch(`${apiUrl}/api/decks`, { signal: AbortSignal.timeout(5000) });
      if (decksRes.ok) {
        const json = (await decksRes.json()) as { data?: unknown[] };
        deckCount = json.data?.length;
      }
    } catch {
      /* decks optional */
    }
    return { connected: true, apiUrl, mcpUrl, deckCount, envOverride };
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

export async function fetchAgentDeckDecks(): Promise<unknown> {
  const res = await fetch(`${getAgentDeckApiUrl()}/api/decks`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Agent Deck API error: ${res.status}`);
  return res.json();
}

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

export function isAgentDeckMcpRegistered(): boolean {
  try {
    const configPath = readClaudeMcpConfigPath();
    if (!fs.existsSync(configPath)) return false;
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as {
      mcpServers?: Record<string, { url?: string }>;
    };
    const expected = new URL(getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "") + "/mcp");
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (!name.toLowerCase().includes("agent-deck") && name !== "agent-deck") continue;
      if (!server.url) continue;
      try {
        const u = new URL(server.url);
        if (u.hostname === expected.hostname && u.port === expected.port) return true;
      } catch {
        // skip invalid url
      }
    }
    return false;
  } catch {
    return false;
  }
}

export type DeliverOutboundResult = {
  toolResult: unknown;
  permalink?: string;
};

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

function extractPermalink(toolResult: unknown): string | undefined {
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

export async function deliverOutboundDraft(
  deckId: string,
  toolCall: OutboundToolCall,
  opts?: {
    workspaceRoot?: string;
    callTool?: (payload: CallServiceToolPayload) => Promise<unknown>;
  }
): Promise<DeliverOutboundResult> {
  const payload = toCallServiceToolPayload(toolCall);
  const workspaceRoot = opts?.workspaceRoot ?? process.cwd();

  const callTool =
    opts?.callTool ??
    (async (p: CallServiceToolPayload) => {
      const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
      const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`));
      const client = new Client({ name: "agent-dealer-deliver", version: "0.0.1" });
      await client.connect(transport);
      try {
        await client.callTool({
          name: "bind_workspace",
          arguments: { deckId, workspaceRoot },
        });
        return await client.callTool({ name: "call_service_tool", arguments: p });
      } finally {
        await client.close();
      }
    });

  const toolResult = await callTool(payload);
  assertCallServiceToolSuccess(toolResult);
  return { toolResult, permalink: extractPermalink(toolResult) };
}
