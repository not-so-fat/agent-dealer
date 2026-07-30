import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activateVersion } from "./activate.js";
import { detectInstallKind } from "./install-kind.js";
import { currentLinkPath, localBinLauncherPath, versionDir } from "./paths.js";

function seedVersion(ver: string) {
  const dir = versionDir(ver);
  const bin = path.join(dir, "node_modules", "agent-dealer", "dist", "bin.js");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "ok\n");
}

test("managed activate preserves sibling data and writes launcher", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adlr-act-"));
  const localBin = path.join(tmp, "local-bin");
  process.env.AGENT_DEALER_HOME = tmp;
  process.env.AGENT_DEALER_LOCAL_BIN = localBin;
  try {
    fs.writeFileSync(path.join(tmp, ".env"), "KEEP=1\n");
    seedVersion("0.1.0");
    activateVersion("0.1.0");
    assert.equal(fs.realpathSync(currentLinkPath()), fs.realpathSync(versionDir("0.1.0")));
    assert.equal(fs.readFileSync(path.join(tmp, ".env"), "utf8"), "KEEP=1\n");
    assert.ok(fs.existsSync(localBinLauncherPath()));
    assert.equal(detectInstallKind(), "managed");
  } finally {
    delete process.env.AGENT_DEALER_HOME;
    delete process.env.AGENT_DEALER_LOCAL_BIN;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
