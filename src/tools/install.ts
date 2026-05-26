import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export const inputSchema = z.object({
  packages: z
    .array(z.string())
    .describe("R package names to install. Example: ['dplyr', 'ggplot2']"),
  repo: z
    .string()
    .optional()
    .describe(
      "CRAN mirror URL. Default: 'https://cloud.r-project.org'"
    ),
});

export type InstallInput = z.infer<typeof inputSchema>;

export function createInstallTool(session: SessionManager) {
  return {
    name: "r_install_packages" as const,
    description:
      "Install R packages from CRAN or another repository. Uses quiet mode to reduce output noise. After installation, verifies by checking package versions.",
    inputSchema,
    handler: async (input: InstallInput) => {
      try {
        const repo = input.repo ?? "https://cloud.r-project.org";
        const packageList = input.packages.map((p) => `"${p}"`).join(", ");

        // Install packages with quiet mode — 5 minute timeout
        const installCode = `install.packages(c(${packageList}), repos="${repo}", quiet=TRUE)`;
        const installResult = await session.execute(installCode, 300000);

        if (installResult.error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `[install error]\n${installResult.error}`,
              },
            ],
          };
        }

        // Verify installation by checking versions
        const verifyCode = `cat(paste(sapply(c(${packageList}), function(p) {
  tryCatch(paste(p, packageVersion(p)), error = function(e) paste(p, "NOT INSTALLED:", conditionMessage(e)))
}), collapse = "\\n"), "\\n")`;

        const verifyResult = await session.execute(verifyCode, 30000);

        const parts: string[] = [];

        if (verifyResult.stdout) {
          parts.push(verifyResult.stdout);
        }

        if (installResult.stdout) {
          parts.push(installResult.stdout);
        }

        if (verifyResult.error) {
          parts.push(`[verification warning]\n${verifyResult.error}`);
        }

        if (installResult.stderr) {
          parts.push(`[stderr]\n${installResult.stderr}`);
        }

        const text = parts.length > 0 ? parts.join("\n") : "Installation complete.";
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
