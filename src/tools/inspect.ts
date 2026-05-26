import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const inputSchema = z.object({
  variable: z
    .string()
    .optional()
    .describe(
      "Name of the R object to inspect. If omitted, lists all objects in .GlobalEnv."
    ),
  mode: z
    .enum(["str", "class", "dim", "summary", "head", "glimpse"])
    .optional()
    .describe("Inspection mode. Default: 'str'."),
});

export type InspectInput = z.infer<typeof inputSchema>;

function buildCode(variable: string | undefined, mode: string): string {
  if (!variable) {
    return `cat(paste(ls(envir=.GlobalEnv), collapse="\\n"), "\\n")`;
  }

  switch (mode) {
    case "str":
      return `cat(capture.output(str(${variable})), sep="\\n")`;
    case "class":
      return `cat(class(${variable}), "\\n")`;
    case "dim":
      return `cat("Dimensions:", paste(dim(${variable}), collapse=" x "), "\\n"); cat("Length:", length(${variable}), "\\n")`;
    case "summary":
      return `cat(capture.output(summary(${variable})), sep="\\n")`;
    case "head":
      return `cat(capture.output(head(${variable}, 20)), sep="\\n")`;
    case "glimpse":
      return `cat(capture.output(str(${variable})), sep="\\n"); cat("Class:", paste(class(${variable}), collapse=", "), "\\n")`;
    default:
      return `cat(capture.output(str(${variable})), sep="\\n")`;
  }
}

export function createInspectTool(session: SessionManager) {
  return {
    name: "r_inspect" as const,
    description:
      "Inspect R objects in the session. Without a variable name, lists all objects. With a variable, shows its structure, class, dimensions, summary, or first rows.",
    inputSchema,
    handler: async (input: InspectInput) => {
      try {
        const mode = input.mode ?? "str";
        const code = buildCode(input.variable, mode);
        const result = await session.execute(code);

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

        const text = parts.length > 0 ? parts.join("\n") : "[no output]";
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
