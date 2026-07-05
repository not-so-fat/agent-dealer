import {
  formatEnvStartupLine,
  loadAgentDealerEnv,
} from "./config/load-env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { enrichPathForCliTools } from "./cli-env.js";
import { migrate } from "./db/index.js";
import { registerRoutes } from "./routes/index.js";
import { startQueue } from "./queue/dispatcher.js";

const { mode, envFile } = loadAgentDealerEnv();
console.log(formatEnvStartupLine(mode, envFile));

const port = Number(process.env.PORT ?? 2221);

async function main(): Promise<void> {
  enrichPathForCliTools();
  migrate();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await registerRoutes(app);

  startQueue();

  await app.listen({ port, host: "0.0.0.0" });
  console.log(`agent-dealer API http://127.0.0.1:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
