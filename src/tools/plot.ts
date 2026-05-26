import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const inputSchema = z.object({
  code: z
    .string()
    .describe(
      "R code that generates a plot. Example: plot(mtcars$mpg, mtcars$hp) or ggplot(mtcars, aes(mpg, hp)) + geom_point()"
    ),
  width: z
    .number()
    .optional()
    .describe("Plot width in pixels. Default: 800."),
  height: z
    .number()
    .optional()
    .describe("Plot height in pixels. Default: 600."),
  dpi: z.number().optional().describe("Plot resolution in DPI. Default: 150."),
});

export type PlotInput = z.infer<typeof inputSchema>;

export function createPlotTool(session: SessionManager) {
  return {
    name: "r_plot" as const,
    description:
      "Execute R plotting code and return the resulting plot as a PNG image. Supports base R graphics and ggplot2. Works with both local R sessions and remote SSH sessions.",
    inputSchema,
    handler: async (input: PlotInput) => {
      let filePath: string | null = null;

      try {
        const w = input.width ?? 800;
        const h = input.height ?? 600;
        const d = input.dpi ?? 150;

        // Step 1: Use R's tempfile() for a portable temp path.
        // This works correctly on both local and remote (SSH) systems.
        const tempPathCode = `cat("AGENTR_PATH", tempfile(fileext=".png"), "AGENTR_END")`;
        const pathResult = await session.execute(tempPathCode);

        if (pathResult.error || !pathResult.stdout.trim()) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to generate temp file path: ${pathResult.error || "empty output"}`,
              },
            ],
          };
        }

        // Extract the path from between our markers.
        // PTY mode echoes the input code, so output may contain extra lines.
        const pathMatch = pathResult.stdout.match(/AGENTR_PATH\s+(.+?)\s+AGENTR_END/);
        if (!pathMatch || !pathMatch[1]) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to parse temp file path from output: ${pathResult.stdout.substring(0, 200)}`,
              },
            ],
          };
        }

        filePath = pathMatch[1].trim();

        // Step 2: Compress user code to single line (required for PTY mode in SSH).
        // PTY sends input line-by-line, so multi-line expressions break.
        const singleLineCode = input.code.replace(/\n/g, " ");

        // Step 3: Build single-line wrapped code for reliable PTY handling
        const wrappedCode = `tryCatch({ png("${filePath}", width=${w}, height=${h}, res=${d}); { ${singleLineCode} }; dev.off(); cat("Plot saved\\n") }, error = function(e) { try(dev.off(), silent = TRUE); cat("Error:", conditionMessage(e), "\\n") })`;

        const plotResult = await session.execute(wrappedCode, 30000);

        if (plotResult.error) {
          return {
            content: [
              { type: "text" as const, text: `[error]\n${plotResult.error}` },
            ],
          };
        }

        // Step 3: Read the plot file (local fs or via SFTP for SSH)
        const imageBuffer = await session.readFile(filePath);
        const base64 = imageBuffer.toString("base64");

        if (base64.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Plot file was empty — the plotting code may not have produced any output.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png",
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
        };
      } finally {
        // Clean up temp file
        if (filePath) {
          session.unlinkFile(filePath).catch(() => {
            /* ignore cleanup errors */
          });
        }
      }
    },
  };
}
