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
      "Get information about the current R session: R version, working directory, loaded packages, objects in the global environment, and recent R command history. Call this FIRST when starting a conversation to understand the user's current work context — the history reveals what analysis they've been doing, what data they've loaded, and what they're working toward.",
    inputSchema,
    handler: async (input: SessionInfoInput) => {
      try {
        const mode = input.mode ?? "basic";
        const parts: string[] = [];

        // Basic info — always included
        const basicResult = await session.execute(
          `cat("R version:", R.version.string, "\\n"); cat("Working directory:", getwd(), "\\n"); cat("Objects in .GlobalEnv:", length(ls(envir=.GlobalEnv)), "\\n")`
        );

        if (basicResult.stdout) parts.push(basicResult.stdout);
        if (basicResult.stderr) parts.push(`[stderr]\n${basicResult.stderr}`);

        // Packages mode
        if (mode === "packages" || mode === "full") {
          const packagesResult = await session.execute(
            `cat("Loaded packages:", paste(.packages(), collapse=", "), "\\n")`
          );
          if (packagesResult.stdout) parts.push(packagesResult.stdout);
        }

        // Full mode — list all objects with their classes
        if (mode === "full") {
          const objectsResult = await session.execute(
            `objs <- ls(envir=.GlobalEnv); if(length(objs)>0) for(obj in objs) { cls <- tryCatch(paste(class(get(obj,envir=.GlobalEnv)),collapse=", "),error=function(e) "unknown"); cat(obj,":",cls,"\\n") } else cat("No objects in .GlobalEnv\\n")`
          );
          if (objectsResult.stdout) parts.push(objectsResult.stdout);
        }

        // Always read R history — provides crucial context about user's work
        const historyResult = await session.execute(
          `tryCatch({ hf <- if(nzchar(Sys.getenv("R_HISTFILE"))) Sys.getenv("R_HISTFILE") else ".Rhistory"; if(!file.exists(hf)) hf <- path.expand("~/.Rhistory"); if(file.exists(hf)) { lines <- tail(readLines(hf,warn=FALSE),50); if(length(lines)>0) { cat("Recent R history (last",length(lines),"commands):\n"); cat(lines,sep="\n"); cat("\n") } else cat("R history file is empty\n") } else cat("No .Rhistory file found\n") }, error=function(e) cat("History unavailable:",conditionMessage(e),"\n"))`
        );
        if (historyResult.stdout) parts.push(historyResult.stdout);

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
