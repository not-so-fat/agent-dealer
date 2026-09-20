import { z } from "zod";

export const Runtime = z.enum(["claude_code", "cursor_local", "codex_local", "muse_code"]);
export type Runtime = z.infer<typeof Runtime>;
