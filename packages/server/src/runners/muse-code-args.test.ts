// packages/server/src/runners/muse-code-args.test.ts
//
// NOT-316: `MUSE_SANDBOX_CAPABILITIES` is mechanically tied to the real launch
// flags — changing `--sandbox-network` without updating the constant fails a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMuseDeveloperInvocation,
  MUSE_SANDBOX_CAPABILITIES,
} from "./muse-code-args.js";

const baseOpts = {
  model: "muse-spark-1.3-contributor",
  maxModelSteps: 40,
  sessionId: "0b6c3f0e-4c2a-4f0e-9d3b-2f6f1a9a7c11",
  prompt: "Implement NOT-1",
};

function sandboxNetworkFlag(): string {
  const args = buildMuseDeveloperInvocation(baseOpts).args;
  const i = args.indexOf("--sandbox-network");
  assert.notEqual(i, -1, "--sandbox-network must be present in the developer argv");
  const value = args[i + 1];
  assert.ok(value, "--sandbox-network must have a value");
  return value;
}

test("NOT-316: MUSE_SANDBOX_CAPABILITIES.sandboxNetwork matches the --sandbox-network flag actually passed", () => {
  assert.equal(sandboxNetworkFlag(), MUSE_SANDBOX_CAPABILITIES.sandboxNetwork);
});

test("NOT-316: sandbox capabilities state the restricted-sandbox limits (no network/listen/browser/credentials)", () => {
  assert.equal(MUSE_SANDBOX_CAPABILITIES.network, "none");
  assert.equal(MUSE_SANDBOX_CAPABILITIES.loopbackListen, false);
  assert.equal(MUSE_SANDBOX_CAPABILITIES.browser, false);
  assert.equal(MUSE_SANDBOX_CAPABILITIES.credentialsKeychain, false);
});
