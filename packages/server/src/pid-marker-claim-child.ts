// packages/server/src/pid-marker-claim-child.ts
//
// Test helper only (spawned by pid-marker.test.ts as a real child process) — attempts a
// single claimPidMarker() call against the path given as argv[2] and prints the outcome
// as JSON, so a test can spawn several of these at once to exercise a genuine multi-process
// race, not just an in-process simulation of one.
import { claimPidMarker } from "./pid-marker.js";

const filePath = process.argv[2];
const claimed = claimPidMarker(filePath, { role: "test-child" });
console.log(JSON.stringify({ pid: process.pid, claimed }));

if (claimed) {
  // Stay alive so any other racing child sees a genuinely *live* owner when it checks —
  // matching how a real long-running server holds this marker for its whole lifetime, not
  // a one-shot script that claims and immediately exits (which would make every later
  // racer see a "stale" marker regardless of who legitimately won). The test kills this
  // process once it has read the result.
  setInterval(() => {}, 1000);
}
