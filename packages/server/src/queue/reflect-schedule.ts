// packages/server/src/queue/reflect-schedule.ts
//
// What is left of the old run dispatcher after NOT-71 removed the plan/execute product:
// the post-delivery playbook reflect (D3 learning loop) that `approve-deliver.ts` fires
// when a Run finishes delivering. Everything else in that module — the snapshot/SSE feed,
// the Linear inbox poll, plan drafting, the plan gate, the execute loop — served only the
// deleted Operations/Inbox/Done screens and was removed with them.
import type { Run } from "@agent-dealer/shared";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { runReflect, type ReflectOpts } from "../runners/reflect.js";

const activeReflects = new Set<string>();

/** Fire-and-forget: post-review playbook reflect (D3 learning loop). */
export function scheduleReflect(run: Run, opts: ReflectOpts): void {
  if (!run.playbookId || !run.deckId) return;
  if (activeReflects.has(run.id)) return;
  void (async () => {
    const online = await checkAgentDeckHealth();
    if (!online) return;
    activeReflects.add(run.id);
    try {
      await runReflect(run, opts);
    } catch (e) {
      console.error("[reflect]", run.id, e);
    } finally {
      activeReflects.delete(run.id);
    }
  })();
}
