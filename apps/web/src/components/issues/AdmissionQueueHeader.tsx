// NOT-643: the Admission queue header bar, extracted as a pure renderable
// unit so regression tests can feed it controlled admission payloads and
// assert the rendered selector for empty and populated queues alike. The
// Issues page renders this unconditionally — only the queue rows below stay
// conditional on waiting entries (NOT-287's idle-line collapse is gone).
import type { AdmissionStatus } from "@agent-dealer/shared";
import { MAX_ACTIVE_ISSUES_HARD_MAX } from "@agent-dealer/shared";

type Props = {
  /** Latest admission read model; null while the first load is in flight. */
  admission: AdmissionStatus | null;
  /** Waiting entries; decides only the pre-admission fallback copy. */
  queueLength: number;
  limitBusy: boolean;
  onLimitChange: (value: number) => void;
};

export default function AdmissionQueueHeader({
  admission,
  queueLength,
  limitBusy,
  onLimitChange,
}: Props) {
  return (
    <div className="px-4 py-2 border-b border-cyber-teal/20 flex items-center justify-between gap-3">
      <span className="font-ui-display text-sm font-medium text-cyber-teal">Admission queue</span>
      <span className="flex items-center gap-2 text-xs text-white/40">
        {admission ? (
          <>
            <span>
              {admission.active} active · {admission.waiting} waiting · limit{" "}
              {admission.limit}
              {admission.overCap ? " · over capacity" : ""}
            </span>
            {admission.options.length > 0 ? (
              <label className="flex items-center gap-1">
                <span className="text-white/35">limit</span>
                <select
                  aria-label="Active issue limit"
                  className="bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-xs text-white/80 disabled:opacity-50"
                  value={admission.options.includes(admission.maxActiveIssues) ? admission.maxActiveIssues : admission.limit}
                  disabled={limitBusy}
                  title={
                    admission.ceiling < MAX_ACTIVE_ISSUES_HARD_MAX
                      ? `Capped by the worker/spawn ceiling (${admission.ceiling})`
                      : "How many issues may execute in parallel (same-repository issues may run together)"
                  }
                  onChange={(e) => onLimitChange(Number(e.target.value))}
                >
                  {admission.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span title={`Capped by the worker/spawn ceiling (${admission.ceiling})`}>
                max {admission.ceiling}
              </span>
            )}
          </>
        ) : queueLength > 0 ? (
          <span>
            {queueLength} waiting · sequential
          </span>
        ) : (
          <span>Loading admission status…</span>
        )}
      </span>
    </div>
  );
}
