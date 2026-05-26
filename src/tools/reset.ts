import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const inputSchema = z.object({}).describe(
  "Reset the R session. Clears all variables, detaches packages, and starts a fresh R process."
);

export type ResetInput = z.infer<typeof inputSchema>;

export function createResetTool(session: SessionManager) {
  return {
    name: "r_reset" as const,
    description:
      "Reset the R session. Kills the current R process and starts a fresh one. All variables, loaded packages, and plot devices are cleared. Use when the session is in a bad state or you want a clean start.",
    inputSchema,
    handler: async (_input: ResetInput) => {
      try {
        await session.reset();
        return {
          content: [
            {
              type: "text" as const,
              text: "R session has been reset. A fresh R process has been started.",
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
        };
      }
    },
  };
}
