import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatestRequestGate } from "./latestRequest";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("NOT-490: a stale poll resolving after a newer refresh is discarded", async () => {
  const gate = createLatestRequestGate();
  const shown: string[] = [];
  const poll = deferred<string>();
  const refresh = deferred<string>();
  const pollDone = gate.run(() => poll.promise, (v) => shown.push(v), () => shown.push("error"));
  const refreshDone = gate.run(() => refresh.promise, (v) => shown.push(v), () => shown.push("error"));

  refresh.resolve("after-save:On");
  await refreshDone;
  assert.deepEqual(shown, ["after-save:On"]);

  poll.resolve("before-save:Off");
  await pollDone;
  assert.deepEqual(shown, ["after-save:On"], "the older poll never overwrites the newer detail");
});

test("NOT-490: a refresh resolving after an older poll is still applied", async () => {
  const gate = createLatestRequestGate();
  const shown: string[] = [];
  const poll = deferred<string>();
  const refresh = deferred<string>();
  const pollDone = gate.run(() => poll.promise, (v) => shown.push(v), () => {});
  const refreshDone = gate.run(() => refresh.promise, (v) => shown.push(v), () => {});
  poll.resolve("before-save:Off");
  await pollDone;
  refresh.resolve("after-save:On");
  await refreshDone;
  assert.deepEqual(shown, ["before-save:Off", "after-save:On"]);
});

test("NOT-490: invalidate drops every in-flight response, including failures", async () => {
  const gate = createLatestRequestGate();
  const shown: string[] = [];
  const a = deferred<string>();
  const b = deferred<string>();
  const aDone = gate.run(() => a.promise, (v) => shown.push(v), () => shown.push("error"));
  const bDone = gate.run(() => b.promise, (v) => shown.push(v), () => shown.push("error"));
  gate.invalidate();
  a.resolve("old-issue");
  b.reject(new Error("boom"));
  await Promise.all([aDone, bDone]);
  assert.deepEqual(shown, []);
});
