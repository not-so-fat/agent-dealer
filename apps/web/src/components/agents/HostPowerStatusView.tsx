// NOT-369: presentational host-power hold line + dismissible sleep-timer notice.
import { useState } from "react";

export type HostPowerStatus = {
  platform: string;
  holdActive: boolean;
  holdCount: number;
  holdStatusLine: string;
  sleepTimerNotice: {
    acSleepMinutes: number;
    message: string;
    fixCommand: string;
  } | null;
};

const DISMISS_KEY = "agent-dealer:host-power-sleep-notice-dismissed";

export function HostPowerStatusView({ status }: { status: HostPowerStatus }) {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof sessionStorage === "undefined") return false;
    try {
      return sessionStorage.getItem(DISMISS_KEY) === status.sleepTimerNotice?.message;
    } catch {
      return false;
    }
  });

  const notice = status.sleepTimerNotice;
  const showNotice = Boolean(notice) && !dismissed;

  const dismiss = () => {
    if (notice) {
      try {
        sessionStorage.setItem(DISMISS_KEY, notice.message);
      } catch {
        // ignore
      }
    }
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
