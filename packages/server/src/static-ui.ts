import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveBundledUiDist(): string | undefined {
  if (process.env.AGENT_DEALER_UI_DIST?.trim()) {
    const custom = path.resolve(process.env.AGENT_DEALER_UI_DIST);
    return fs.existsSync(custom) ? custom : undefined;
  }

  const bundled = path.join(__dirname, "..", "static-ui");
  return fs.existsSync(bundled) ? bundled : undefined;
}

export async function registerStaticUi(app: FastifyInstance): Promise<string | undefined> {
  const uiDist = resolveBundledUiDist();
  if (!uiDist) {
    return undefined;
  }

  await app.register(fastifyStatic, {
    root: uiDist,
    prefix: "/",
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/health") {
      return reply.status(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html", uiDist);
  });

  return uiDist;
}
