// NOT-369: presentational host-power hold line + dismissible sleep-timer notice.
import { useEffect, useState } from "react";

export type HostPowerStatus = {
  platform: string;
  /** Server process id — dismissal is scoped to this instance (once per start). */
  serverInstanceId: string;
  holdActive: boolean;
  holdCount: number;
  holdStatusLine: string;
  sleepTimerNotice: {
    acSleepMinutes: number;
    message: string;
    fixCommand: string;
  } | null;
};

const DISMISS_KEY_PREFIX = "agent-dealer:host-power-sleep-notice-dismissed:";

function dismissStorageKey(serverInstanceId: string): string {
  return `${DISMISS_KEY_PREFIX}${serverInstanceId}`;
}

function readDismissed(serverInstanceId: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    // localStorage so every tab for this server instance shares one dismissal.
    return localStorage.getItem(dismissStorageKey(serverInstanceId)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(serverInstanceId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(dismissStorageKey(serverInstanceId), "1");
  } catch {
    // ignore quota / private-mode failures
  }
}

export function HostPowerStatusView({ status }: { status: HostPowerStatus }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(status.serverInstanceId));

  // Server restart → new instance id; re-read so a prior dismissal does not suppress the notice.
  useEffect(() => {
    setDismissed(readDismissed(status.serverInstanceId));
  }, [status.serverInstanceId]);

  const notice = status.sleepTimerNotice;
  const showNotice = Boolean(notice) && !dismissed;

  const dismiss = () => {
    writeDismissed(status.serverInstanceId);
    setDismissed(true);
  };

  return (
    <div className="space-y-2" data-testid="host-power-status">
      <p className="text-xs text-white/45 font-mono" data-testid="host-power-hold-line">
        {status.holdStatusLine}
      </p>
      {showNotice && notice && (
        <div
          className="flex flex-wrap items-start justify-between gap-2 rounded border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90"
          data-testid="host-power-sleep-notice"
          role="status"
        >
          <p className="min-w-0 flex-1 leading-relaxed font-mono">{notice.message}</p>
          <button
            type="button"
            onClick={dismiss}
            className="shrink-0 text-amber-100/70 hover:text-amber-50 underline-offset-2 hover:underline"
            data-testid="host-power-sleep-notice-dismiss"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Test helper — dismissal key shape used by the view. */
export function hostPowerSleepNoticeDismissKey(serverInstanceId: string): string {
  return dismissStorageKey(serverInstanceId);
}
