// NOT-369: polls /api/host-power for the Agents health area.
import { useEffect, useState } from "react";
import { fetchHostPower } from "../../api";
import { HostPowerStatusView, type HostPowerStatus } from "./HostPowerStatusView";

export type { HostPowerStatus };
export { HostPowerStatusView };

type Props = {
  /** Injected status for tests; production fetches /api/host-power. */
  status?: HostPowerStatus | null;
  pollMs?: number;
};

/** Polls host-power status for the Agents health area (once per server start notice). */
export default function HostPowerStatus({ status: injected, pollMs = 5000 }: Props) {
  const [status, setStatus] = useState<HostPowerStatus | null>(injected ?? null);

  useEffect(() => {
    if (injected !== undefined) {
      setStatus(injected);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchHostPower()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [injected, pollMs]);

  if (!status) return null;
  return <HostPowerStatusView status={status} />;
}
