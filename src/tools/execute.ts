import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const inputSchema = z.object({
  code: z
    .string()
    .describe(
      "R code to execute. Can be multi-line. Variables and loaded packages persist between calls."
    ),
  timeout: z
    .number()
    .optional()
    .describe("Execution timeout in milliseconds. Default: 60000."),
});

export type ExecuteInput = z.infer<typeof inputSchema>;

function formatOutput(result: {
  stdout: string;
  stderr: string;
  error: string | null;
  truncated: boolean;
  incomplete: boolean;
}): string {
  const parts: string[] = [];

  if (result.stdout) {
    parts.push(result.stdout);
  }

  if (result.stderr) {
    parts.push(`[stderr]\n${result.stderr}`);
  }

  if (result.error) {
    parts.push(`[error]\n${result.error}`);
  }

  if (result.truncated) {
    parts.push("[output truncated]");
  }

  if (result.incomplete) {
    parts.push(
      "[incomplete expression — code ended mid-block, waiting for continuation]"
    );
  }

  return parts.length > 0 ? parts.join("\n") : "[no output]";
}

export function createExecuteTool(session: SessionManager) {
  return {
    name: "r_execute" as const,
    description:
      "Execute R code in a persistent interactive R session. Variables, functions, and loaded packages persist between calls. Use for data analysis, statistical modeling, and any R computation.",
    inputSchema,
    handler: async (input: ExecuteInput) => {
      try {
        const result = await session.execute(input.code, input.timeout);
        const text = formatOutput(result);
        return {
          content: [{ type: "text" as const, text }],
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
