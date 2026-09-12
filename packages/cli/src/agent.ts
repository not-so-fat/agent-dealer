import { apiFetch } from "./http.js";

export async function runAgentCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  try {
    if (subcommand === "list") {
      const result = await apiFetch("/api/agents");
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.error(`Unknown agent subcommand: ${subcommand}`);
    return 1;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
