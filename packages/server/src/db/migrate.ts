import {
  formatEnvStartupLine,
  loadAgentDealerEnv,
} from "../config/load-env.js";
import { migrate, getDbPath } from "./index.js";

const { mode, envFile } = loadAgentDealerEnv();
console.log(formatEnvStartupLine(mode, envFile));

migrate();
console.log("Database migrated:", getDbPath());
