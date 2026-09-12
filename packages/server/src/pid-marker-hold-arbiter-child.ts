// packages/server/src/pid-marker-hold-arbiter-child.ts
//
// Test helper only (spawned by pid-marker.test.ts) — opens the same `.arbiter` SQLite file
// claimPidMarker() uses, takes its BEGIN EXCLUSIVE lock, prints "held" once acquired, then
// blocks forever (until killed). Used to prove that a process crashing while it holds the
// arbiter lock does not wedge it: the OS releases the advisory lock the instant this
// process dies, for any reason — there is no lease/timeout heuristic to get right, unlike
// a hand-rolled lock *file* (which is exactly the bug this design replaced).
import Database from "better-sqlite3";

const filePath = process.argv[2];
const db = new Database(`${filePath}.arbiter`);
db.pragma("busy_timeout = 3000");

db.transaction(() => {
  // Print our *real* pid, not the tsx launcher's: the test kills this exact pid directly
  // with SIGKILL to simulate a crash — killing the tsx wrapper process alone does not
  // reach this actual node process running the script (the wrapper forks a child to run
  // it and does not forward an unblockable SIGKILL, only a catchable SIGTERM).
  console.log(JSON.stringify({ event: "held", pid: process.pid }));
  // Block forever while still inside the transaction (still holding the exclusive lock) —
  // this process is only ever meant to be terminated externally (SIGKILL), simulating a
  // crash mid-lock.
  const SharedArrayBufferBlock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(SharedArrayBufferBlock, 0, 0);
}).exclusive();
