/**
 * PoC: send a Slack message via Agent Deck MCP call_service_tool (server deliver path).
 * Requires: Agent Deck running, SEND_POC_SERVICE_ID, SEND_POC_CHANNEL, SEND_POC_MESSAGE.
 * Skips cleanly when env vars are unset (CI-safe).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadAgentDealerEnv } from "../load-env.ts";

loadAgentDealerEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOG_DIR = path.join(ROOT, ".temporal/logs");

function mcpUrl(): string {
  const api = process.env.AGENT_DECK_API_URL ?? "http://127.0.0.1:1111";
  try {
    const u = new URL(api);
    const mcpPort = Number(u.port) - 1;
    return `${u.protocol}//${u.hostname}:${mcpPort}/mcp`;
  } catch {
    return "http://127.0.0.1:1110/mcp";
  }
}

async function main(): Promise<void> {
  const serviceId = process.env.SEND_POC_SERVICE_ID;
  const channel = process.env.SEND_POC_CHANNEL;
  const message = process.env.SEND_POC_MESSAGE ?? `agent-dealer send PoC ${new Date().toISOString()}`;

  if (!serviceId || !channel) {
    console.log("SKIP agent-deck-send: set SEND_POC_SERVICE_ID and SEND_POC_CHANNEL to run live Slack send");
    return;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `poc-agent-deck-send-${Date.now()}.json`);

  const url = mcpUrl();
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "agent-dealer-send-poc", version: "0.0.1" });
  await client.connect(transport);

  const deckId = process.env.SEND_POC_DECK_ID ?? "82b516d3-b89b-49ad-b158-14124a91dd1a";
  const workspaceRoot = process.env.SEND_POC_WORKSPACE ?? process.cwd();
  await client.callTool({
    name: "bind_workspace",
    arguments: { deckId, workspaceRoot },
  });

  const toolArgs = {
    serviceId,
    toolName: "slack_send_message",
    arguments: { channel_id: channel, message },
  };

  const result = await client.callTool({
    name: "call_service_tool",
    arguments: toolArgs,
  });

  fs.writeFileSync(logPath, JSON.stringify({ url, toolArgs, result }, null, 2));

  const text = JSON.stringify(result);
  if (result.isError || /"success":\s*false/i.test(text)) {
    throw new Error(`call_service_tool failed: ${text.slice(0, 500)}`);
  }

  console.log(`OK agent-deck-send: message posted to ${channel}`);
  console.log(`Log: ${logPath}`);
  await client.close();
}

main().catch((e) => {
  console.error("FAIL agent-deck-send:", e);
  process.exit(1);
});
