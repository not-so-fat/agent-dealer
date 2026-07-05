import { z } from "zod";

export const Runtime = z.enum(["claude_code", "cursor_local"]);
export type Runtime = z.infer<typeof Runtime>;
