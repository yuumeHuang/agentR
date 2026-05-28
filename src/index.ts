#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SessionManager, type SessionOptions } from "./session-manager.js";
import { createExecuteTool } from "./tools/execute.js";
import { createInspectTool } from "./tools/inspect.js";
import { createPlotTool } from "./tools/plot.js";
import { createInstallTool } from "./tools/install.js";
import { createSessionInfoTool } from "./tools/session-info.js";
import { createResetTool } from "./tools/reset.js";

/**
 * Build SessionOptions from environment variables.
 *
 * SSH mode is activated when AGENT_R_SSH_HOST is set.
 *
 * Environment variables:
 *   AGENT_R_PATH               - Path to R binary (default: "R")
 *   AGENT_R_TIMEOUT            - Idle timeout in ms, resets on each output (default: 60000)
 *   AGENT_R_MAX_TOTAL_TIMEOUT  - Absolute max execution time in ms (default: 600000)
 *   AGENT_R_SSH_HOST           - SSH host (enables SSH mode)
 *   AGENT_R_SSH_PORT           - SSH port (default: 22)
 *   AGENT_R_SSH_USER           - SSH username
 *   AGENT_R_SSH_PASSWORD       - SSH password auth
 *   AGENT_R_SSH_KEY            - SSH private key (file path or content)
 *   AGENT_R_SSH_PASSPHRASE     - Passphrase for private key
 */
function buildOptionsFromEnv(): SessionOptions {
  const options: SessionOptions = {
    rPath: process.env.AGENT_R_PATH || "R",
    timeout: process.env.AGENT_R_TIMEOUT
      ? parseInt(process.env.AGENT_R_TIMEOUT, 10)
      : 60000,
    maxTotalTimeout: process.env.AGENT_R_MAX_TOTAL_TIMEOUT
      ? parseInt(process.env.AGENT_R_MAX_TOTAL_TIMEOUT, 10)
      : undefined,
  };

  const mode = process.env.AGENT_R_MODE || "spawn";
  const sshHost = process.env.AGENT_R_SSH_HOST;

  if (mode === "attach") {
    if (!sshHost) {
      throw new Error("AGENT_R_MODE=attach requires AGENT_R_SSH_HOST");
    }
    options.attach = {
      port: process.env.AGENT_R_ATTACH_PORT
        ? parseInt(process.env.AGENT_R_ATTACH_PORT, 10)
        : 9876,
      ssh: {
        host: sshHost,
        port: process.env.AGENT_R_SSH_PORT
          ? parseInt(process.env.AGENT_R_SSH_PORT, 10)
          : 22,
        username: process.env.AGENT_R_SSH_USER || "",
        password: process.env.AGENT_R_SSH_PASSWORD,
        privateKey: process.env.AGENT_R_SSH_KEY,
        passphrase: process.env.AGENT_R_SSH_PASSPHRASE,
      },
    };
    // Override rPath for remote — default to "R" on Linux servers
    options.rPath = process.env.AGENT_R_PATH || "R";
  } else if (sshHost) {
    options.ssh = {
      host: sshHost,
      port: process.env.AGENT_R_SSH_PORT
        ? parseInt(process.env.AGENT_R_SSH_PORT, 10)
        : 22,
      username: process.env.AGENT_R_SSH_USER || "",
      password: process.env.AGENT_R_SSH_PASSWORD,
      privateKey: process.env.AGENT_R_SSH_KEY,
      passphrase: process.env.AGENT_R_SSH_PASSPHRASE,
    };
    // Override rPath for remote — default to "R" on Linux servers
    options.rPath = process.env.AGENT_R_PATH || "R";
  }

  return options;
}

async function main() {
  const options = buildOptionsFromEnv();

  // Create session manager (R starts lazily on first execute)
  const session = new SessionManager(options);

  const modeDesc = options.attach
    ? `attach → ${options.attach.ssh.username}@${options.attach.ssh.host}:${options.attach.port}`
    : options.ssh
    ? `SSH → ${options.ssh.username}@${options.ssh.host}:${options.ssh.port ?? 22}`
    : "local";

  // Log to stderr (stdout is used for MCP protocol)
  process.stderr.write(`agentR MCP server starting (${modeDesc})\n`);

  // Create MCP server
  const server = new McpServer({
    name: "agentR",
    version: "0.1.0",
  });

  // Register each tool with the MCP server.
  // server.tool(name, description, rawShape, handler) — each tool's
  // inputSchema.shape provides the ZodRawShapeCompat the SDK expects.
  const execute = createExecuteTool(session);
  server.tool(
    execute.name,
    execute.description,
    execute.inputSchema.shape,
    execute.handler,
  );

  const inspect = createInspectTool(session);
  server.tool(
    inspect.name,
    inspect.description,
    inspect.inputSchema.shape,
    inspect.handler,
  );

  const plot = createPlotTool(session);
  server.tool(
    plot.name,
    plot.description,
    plot.inputSchema.shape,
    plot.handler,
  );

  const install = createInstallTool(session);
  server.tool(
    install.name,
    install.description,
    install.inputSchema.shape,
    install.handler,
  );

  const sessionInfo = createSessionInfoTool(session);
  server.tool(
    sessionInfo.name,
    sessionInfo.description,
    sessionInfo.inputSchema.shape,
    sessionInfo.handler,
  );

  const reset = createResetTool(session);
  server.tool(
    reset.name,
    reset.description,
    reset.inputSchema.shape,
    reset.handler,
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  const cleanup = async () => {
    await session.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stderr.write(`agentR MCP server started (${modeDesc})\n`);
}

main().catch((err) => {
  process.stderr.write(`agentR MCP server failed: ${err}\n`);
  process.exit(1);
});
