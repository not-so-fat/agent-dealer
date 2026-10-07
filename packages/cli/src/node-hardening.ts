import net from "node:net";

type SetTypeOfService = (tos: number) => net.Socket;

const PATCHED = "__agentDealerSetTypeOfServicePatched__";

function isSetTypeOfServiceEinval(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return code === "EINVAL" && syscall === "setTypeOfService";
}

/**
 * NOT-370: Node's bundled undici can throw `setTypeOfService EINVAL` synchronously from a
 * socket write when a localhost peer resets (macOS, Node 24) — outside the fetch promise,
 * so try/catch around fetch cannot observe it and the CLI dies with an uncaught exception.
 * Local probes avoid fetch entirely (see ports.ts), but direct fetch users (start health
 * wait, apiFetch) keep this narrow backstop: swallow exactly that errno shape, rethrow
 * everything else. Idempotent.
 */
export function installNodeHardening(): void {
  const proto = net.Socket.prototype as unknown as Record<string, unknown>;
  const current = proto.setTypeOfService as SetTypeOfService & Record<string, unknown>;
  if (typeof current !== "function" || current[PATCHED] === true) {
    return;
  }
  const original = current;
  const patched = function patchedSetTypeOfService(this: net.Socket, tos: number): net.Socket {
    try {
      return original.call(this, tos);
    } catch (error) {
      if (isSetTypeOfServiceEinval(error)) {
        return this;
      }
      throw error;
    }
  };
  (patched as unknown as Record<string, unknown>)[PATCHED] = true;
  proto.setTypeOfService = patched;
}
