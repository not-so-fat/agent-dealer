import { runDoctor } from "./doctor.js";
import { runSetup, printSetupHelp } from "./setup.js";
import { runStart, printStartHelp } from "./start.js";
import { runStatus } from "./status.js";
import { runStop } from "./stop.js";
import { maybeCheckForUpdateOnRun } from "./update-check.js";
import { getVersion } from "./version.js";
import { runUpgrade, printUpgradeHelp } from "./upgrade.js";

function printUsage(): void {
  console.log(`Usage:
  agent-dealer setup [--home DIR] [--force]
  agent-dealer start [--daemon] [--port PORT] [--open] [--force]
  agent-dealer stop
  agent-dealer status
  agent-dealer doctor
  agent-dealer upgrade [--to VERSION] [--yes]
  agent-dealer --version

Human control plane for agent execution.`);
}

export async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return 0;
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log(getVersion());
    return 0;
  }

  if (cmd === "setup") {
    if (args.includes("--help")) {
      printSetupHelp();
      return 0;
    }
    let home: string | undefined;
    let force = false;
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === "--home") home = args[++i];
      else if (args[i] === "--force") force = true;
      else {
        console.error(`Unknown setup option: ${args[i]}`);
        return 1;
      }
    }
    return runSetup({ home, force });
  }

  if (cmd === "start") {
    if (args.includes("--help")) {
      printStartHelp();
      return 0;
    }
    const { upgraded } = await maybeCheckForUpdateOnRun();
    if (upgraded) return 0;
    let port: number | undefined;
    let open = false;
    let daemon = false;
    let force = false;
    let supervisor = false;
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--port") port = Number(args[++i]);
      else if (arg === "--open") open = true;
      else if (arg === "--daemon") daemon = true;
      else if (arg === "--force") force = true;
      else if (arg === "--_supervisor") supervisor = true;
      else {
        console.error(`Unknown start option: ${arg}`);
        return 1;
      }
    }
    return runStart({ port, open, daemon, force, supervisor });
  }

  if (cmd === "stop") {
    return runStop();
  }

  if (cmd === "status") {
    return runStatus();
  }

  if (cmd === "doctor") {
    const { upgraded } = await maybeCheckForUpdateOnRun();
    if (upgraded) return 0;
    return runDoctor();
  }

  if (cmd === "upgrade") {
    if (args.includes("--help")) {
      printUpgradeHelp();
      return 0;
    }
    let toVersion: string | undefined;
    let yes = false;
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === "--to") toVersion = args[++i];
      else if (args[i] === "--yes") yes = true;
      else {
        console.error(`Unknown upgrade option: ${args[i]}`);
        return 1;
      }
    }
    return runUpgrade({ toVersion, yes });
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  return 1;
}
