import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStop } from "./stop.js";

const HEALTH_SERVER = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

/** A separate process answering /health, standing in for an agent-dealer server. */
async function startFakeServer(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ["-e", HEALTH_SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  });
  return { child, port };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 25; i += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-dealer-stop-"));
}

test("stop with an explicit AGENT_DEALER_HOME and no run state never kills a listener on the fallback port", async () => {
  const { child, port } = await startFakeServer();
  const home = tempHome();
  try {
    await withEnv({ AGENT_DEALER_HOME: home, PORT: String(port), WEB_PORT: undefined }, async () => {
      assert.equal(await runStop(), 0);
    });
    assert.equal(isAlive(child.pid!), true, "the unrelated listener must survive an isolated-home stop");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stop with an explicit AGENT_DEALER_HOME still terminates the pids recorded in its run.json", async () => {
  const { child, port } = await startFakeServer();
  const home = tempHome();
  fs.writeFileSync(
    path.join(home, "run.json"),
    JSON.stringify({ host: "127.0.0.1", port, serverPid: child.pid, cliPid: 2 ** 22, startedAt: new Date().toISOString() }),
  );
  try {
    await withEnv({ AGENT_DEALER_HOME: home, PORT: undefined, WEB_PORT: undefined }, async () => {
      assert.equal(await runStop(), 0);
    });
    assert.equal(await waitUntilDead(child.pid!), true);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stop on the default home keeps sweeping the port when run.json is lost", async () => {
  const { child, port } = await startFakeServer();
  const home = tempHome();
  try {
    await withEnv(
      { AGENT_DEALER_HOME: undefined, HOME: home, USERPROFILE: home, PORT: String(port), WEB_PORT: undefined },
      async () => {
        assert.equal(await runStop(), 0);
      },
    );
    assert.equal(await waitUntilDead(child.pid!), true);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});
