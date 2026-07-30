import fs from "node:fs";
import path from "node:path";

import { updateStatePath } from "./paths.js";

export interface UpdateState {
  checkedAt: string;
  latest: string | null;
  pendingVersion: string | null;
}

export function readUpdateState(): UpdateState | null {
  try {
    const raw = fs.readFileSync(updateStatePath(), "utf8");
    const parsed = JSON.parse(raw) as UpdateState;
    return {
      checkedAt: parsed.checkedAt,
      latest: parsed.latest ?? null,
      pendingVersion: parsed.pendingVersion ?? null,
    };
  } catch {
    return null;
  }
}

export function writeUpdateState(state: UpdateState): void {
  const file = updateStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
