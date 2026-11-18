import { CreateIssueInput } from "@agent-dealer/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, InjectOptions } from "fastify";

type Arguments = Record<string, unknown>;
type DealerTool = Tool & { run(args: Arguments): Promise<CallToolResult> };

// Advertise the wire schema without parsing early so REST owns validation and defaults.
const createIssueSchema = { ...toJsonSchemaCompat(CreateIssueInput), type: "object" as const };

function objectSchema(properties: Record<string, object> = {}, required: string[] = []): Tool["inputSchema"] {
  return { type: "object", properties, required };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError && { isError }) };
}

function restError(status: number, body: string): CallToolResult {
  return textResult(`HTTP ${status}: ${body}`, true);
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function createServer(app: FastifyInstance): Server {
  const server = new Server({ name: "dealer", version: "1.0.0" }, { capabilities: { tools: {} } });
  const tools = new Map<string, DealerTool>();
  const add = (
    name: string,
    description: string,
    readOnlyHint: boolean,
    inputSchema: Tool["inputSchema"],
    run: DealerTool["run"],
  ) => tools.set(name, { name, description, inputSchema, annotations: { readOnlyHint }, run });

  const rest = async (options: InjectOptions) => {
    const response = await app.inject(options);
    return isSuccess(response.statusCode)
      ? textResult(response.body)
      : restError(response.statusCode, response.body);
  };

  const withId = (
    key: string,
    run: (id: string, args: Arguments) => Promise<CallToolResult>,
  ): DealerTool["run"] => async (args) => {
    const id = args[key];
    if (typeof id !== "string" || id === "" || id === "." || id === "..") {
      return restError(400, JSON.stringify({ error: `${key} must be a non-empty resource ID` }));
    }
    return run(encodeURIComponent(id), args);
  };
  const string = { type: "string" };
  const integer = { type: "integer" };

  add("list_agents", "List Dealer agents and their health.", true, objectSchema(),
    () => rest({ method: "GET", url: "/api/agents" }));
  add("lookup_linear_issue", "Look up a Linear identifier or issue URL.", true,
    objectSchema({ ref: string }, ["ref"]),
    ({ ref }) => rest({
      method: "GET",
      url: "/api/intake/linear/lookup",
      query: typeof ref === "string" ? { q: ref } : {},
    }));
  add("list_issues", "List Dealer issues with optional search, status, and pagination.", true,
    objectSchema({ q: string, status: string, page: integer, limit: integer }),
    ({ q, status, page, limit }) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ q, status, page, limit })) {
        if (typeof value === "string" || typeof value === "number") query.set(key, String(value));
      }
      return rest({ method: "GET", url: `/api/issues?${query}` });
    });
  add("get_issue", "Get a Dealer issue by ID.", true,
    objectSchema({ issueId: string }, ["issueId"]),
    withId("issueId", (id) => rest({ method: "GET", url: `/api/issues/${id}` })));
  add("get_queue", "Get queued issues and admission status.", true, objectSchema(), async () => {
    const queue = await app.inject({ method: "GET", url: "/api/queue" });
    if (!isSuccess(queue.statusCode)) return restError(queue.statusCode, queue.body);
    const status = await app.inject({ method: "GET", url: "/api/queue/status" });
    if (!isSuccess(status.statusCode)) return restError(status.statusCode, status.body);
    return textResult(JSON.stringify({ queue: queue.json(), status: status.json() }));
  });
  add("list_human_actions", "List open human actions and their available choices.", true,
    objectSchema(), () => rest({ method: "GET", url: "/api/human-actions" }));

  add("create_issue", "Create a Dealer issue, queued by default. Set enqueue to false for a draft.",
    false, createIssueSchema,
    (payload) => rest({ method: "POST", url: "/api/issues", payload }));
  add("add_guidance", "Append Markdown guidance for the next worker session.", false,
    objectSchema({ issueId: string, markdown: string }, ["issueId", "markdown"]),
    withId("issueId", (id, { markdown }) => rest({
      method: "POST", url: `/api/issues/${id}/guidance`, payload: { markdown },
    })));
  add("resolve_human_action", "Resolve an open action with one of its available choices.", false,
    objectSchema({ actionId: string, choice: string, note: string }, ["actionId", "choice"]),
    withId("actionId", (id, { choice, note }) => rest({
      method: "POST",
      url: `/api/human-actions/${id}/resolve`,
      payload: { resolvedBy: "agent", choice, note },
    })));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Array.from(tools.values(), ({ name, description, inputSchema, annotations }) => ({
      name, description, inputSchema, annotations,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = tools.get(params.name);
    if (!tool) return textResult(`Unknown tool: ${params.name}`, true);
    return tool.run(params.arguments ?? {});
  });
  return server;
}

function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(origin)
    && URL.canParse(origin);
}

export async function registerMcpRoutes(app: FastifyInstance, port: number): Promise<void> {
  app.route({
    method: ["POST", "GET", "DELETE", "OPTIONS"],
    url: "/mcp",
    exposeHeadRoute: false,
    config: { cors: { preflightContinue: true, strictPreflight: false } },
    onRequest: async (request, reply) => {
      const address = app.server.address();
      const localPort = address && typeof address === "object" ? address.port : port;
      const host = request.headers.host?.toLowerCase();
      if (host !== `127.0.0.1:${localPort}` && host !== `localhost:${localPort}`) {
        return reply.code(403).send({ error: "MCP requires a loopback Host on the Dealer port" });
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        return reply.code(403).send({ error: "MCP requires a loopback Origin" });
      }
    },
    handler: async (request, reply) => {
      if (request.method === "OPTIONS") return reply.code(204).send();
      if (request.method !== "POST") return reply.code(405).header("allow", "POST").send();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = createServer(app);
      try {
        await server.connect(transport);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(name, String(value));
        }
        const response = await transport.handleRequest(new Request(
          `http://${request.headers.host}/mcp`, { method: "POST", headers },
        ), { parsedBody: request.body });
        for (const [name, value] of response.headers) reply.header(name, value);
        return reply.code(response.status).send(response.body ? await response.text() : undefined);
      } finally {
        await server.close();
      }
    },
  });
}
