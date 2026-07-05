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
