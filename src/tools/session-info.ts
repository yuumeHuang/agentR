import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const inputSchema = z.object({
  mode: z
    .enum(["basic", "packages", "full"])
    .optional()
    .describe(
      "Level of detail. 'basic': R version + working directory + object count. 'packages': basic + loaded packages. 'full': packages + all objects with their classes. Default: 'basic'."
    ),
});

export type SessionInfoInput = z.infer<typeof inputSchema>;

export function createSessionInfoTool(session: SessionManager) {
  return {
    name: "r_session_info" as const,
    description:
      "Get information about the current R session: R version, working directory, loaded packages, and objects in the global environment.",
    inputSchema,
    handler: async (input: SessionInfoInput) => {
      try {
        const mode = input.mode ?? "basic";

        // Basic info — always included
        const basicCode = [
          `cat("R version:", R.version.string, "\\n")`,
          `cat("Working directory:", getwd(), "\\n")`,
          `cat("Objects in .GlobalEnv:", length(ls(envir=.GlobalEnv)), "\\n")`,
        ].join("\n");

        const basicResult = await session.execute(basicCode);
        const parts: string[] = [];

        if (basicResult.stdout) {
          parts.push(basicResult.stdout);
        }
        if (basicResult.stderr) {
          parts.push(`[stderr]\n${basicResult.stderr}`);
        }

        // Packages mode
        if (mode === "packages" || mode === "full") {
          const packagesCode = `cat("Loaded packages:", paste(.packages(), collapse=", "), "\\n")`;
          const packagesResult = await session.execute(packagesCode);

          if (packagesResult.stdout) {
            parts.push(packagesResult.stdout);
          }
        }

        // Full mode — list all objects with their classes
        if (mode === "full") {
          const objectsCode = [
            `objs <- ls(envir=.GlobalEnv)`,
            `if (length(objs) > 0) {`,
            `  for (obj in objs) {`,
            `    cls <- tryCatch(paste(class(get(obj, envir=.GlobalEnv)), collapse=", "), error = function(e) "unknown")`,
            `    cat(obj, ":", cls, "\\n")`,
            `  }`,
            `} else {`,
            `  cat("No objects in .GlobalEnv\\n")`,
            `}`,
          ].join("\n");

          const objectsResult = await session.execute(objectsCode);

          if (objectsResult.stdout) {
            parts.push(objectsResult.stdout);
          }
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
