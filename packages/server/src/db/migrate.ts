import { migrate } from "./index.js";

migrate();
console.log("Database migrated:", process.env.AGENT_DEALER_HOME ?? "~/.agent-dealer/dealer.db");
