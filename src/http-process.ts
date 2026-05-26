/**
 * HttpRProcess — implements RProcess over HTTP through an SSH tunnel.
 *
 * Instead of spawning a new R process, connects to an already-running
 * httpuv R server on a remote host via SSH port forwarding (forwardOut).
 * Each code execution becomes an HTTP POST to /execute.
 *
 * Key differences from SshRProcess (spawn mode):
 * - No R startup or DONE_MARKER handshake — the server is already running
 * - writeStdin() buffers code and fires synchronous HTTP requests
 * - onStderr is a no-op — errors come in the JSON response body
 * - Provides readFile/unlinkFile via HTTP endpoints (not SFTP)
 */

import { Client, type ClientChannel } from "ssh2";
import { readFileSync } from "node:fs";
import type { RProcess } from "./r-process.js";
import type { SshConfig } from "./ssh-process.js";

export class HttpRProcess implements RProcess {
  private sshClient: Client | null = null;
  private alive = false;
  private port = 0;
  private codeBuffer = "";

  private stdoutHandlers: Array<(data: Buffer | string) => void> = [];
  private stderrHandlers: Array<(data: Buffer | string) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];

  /**
   * Connect to the SSH server and verify the httpuv R server is running.
   */
  async connect(sshConfig: SshConfig, port: number): Promise<void> {
    this.port = port;

    return new Promise<void>((resolve, reject) => {
      const client = new Client();

      client.on("error", (err) => {
        this.alive = false;
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      client.on("close", () => {
        this.alive = false;
        for (const handler of this.exitHandlers) {
          handler(null);
        }
      });

      client.on("ready", () => {
        this.sshClient = client;
        this.alive = true;

        // Verify the httpuv server is running with a GET /status
        this.httpRequest("GET", "/status")
          .then((res) => {
            if (res.status !== 200) {
              client.end();
              this.alive = false;
              this.sshClient = null;
              reject(
                new Error(
                  `httpuv server not running on remote:${port}. ` +
                    `Did you source agentR.R and call agentR_serve()? ` +
                    `(HTTP ${res.status})`
                )
              );
              return;
            }
            resolve();
          })
          .catch((err) => {
            client.end();
            this.alive = false;
            this.sshClient = null;
            reject(
              new Error(
                `httpuv server not running on remote:${port}. ` +
                  `Did you source agentR.R and call agentR_serve()? ` +
                  `(${err instanceof Error ? err.message : String(err)})`
              )
            );
          });
      });

      // Build connect config (same pattern as SshRProcess)
      const connectConfig: Record<string, unknown> = {
        host: sshConfig.host,
        port: sshConfig.port ?? 22,
        username: sshConfig.username,
        readyTimeout: 15000,
      };

      if (sshConfig.password) {
        connectConfig.password = sshConfig.password;
      } else if (sshConfig.privateKey) {
        try {
          connectConfig.privateKey = readFileSync(sshConfig.privateKey);
        } catch {
          connectConfig.privateKey = sshConfig.privateKey;
        }
        if (sshConfig.passphrase) {
          connectConfig.passphrase = sshConfig.passphrase;
        }
      }

      client.connect(connectConfig);
    });
  }

  writeStdin(data: string): void {
    this.codeBuffer += data;

    // When a newline is detected, the command is complete — fire HTTP request
    if (data.endsWith("\n")) {
      const code = this.codeBuffer.slice(0, -1); // strip trailing \n
      this.codeBuffer = "";

      if (code.length === 0) return;

      this.executeCode(code);
    }
  }

  private async executeCode(code: string): Promise<void> {
    try {
      const body = JSON.stringify({ code });
      const res = await this.httpRequest("POST", "/execute", body);

      if (res.status !== 200) {
        // HTTP-level error
        const errorText = res.body.toString("utf-8");
        const output = `HTTP ${res.status}: ${errorText}\n___MCP_DONE___\n`;
        for (const handler of this.stdoutHandlers) {
          handler(output);
        }
        return;
      }

      // Parse JSON response
      let parsed: { output?: string; error?: string | null; status?: string };
      try {
        parsed = JSON.parse(res.body.toString("utf-8"));
      } catch {
        // If JSON parse fails, treat raw body as output
        const output = `${res.body.toString("utf-8")}\n___MCP_DONE___\n`;
        for (const handler of this.stdoutHandlers) {
          handler(output);
        }
        return;
      }

      let output = parsed.output ?? "";
      // jsonlite serializes NULL as {} (empty object), so check for actual error content
      const hasError = parsed.error && typeof parsed.error === "string" && parsed.error.length > 0;
      if (hasError) {
        output = `${parsed.error}\n${output}`;
      }
      output += "\n___MCP_DONE___\n";

      for (const handler of this.stdoutHandlers) {
        handler(output);
      }
    } catch (err) {
      // Network/SSH error
      const errorOutput = `Error: ${err instanceof Error ? err.message : String(err)}\n___MCP_DONE___\n`;
      for (const handler of this.stdoutHandlers) {
        handler(errorOutput);
      }
    }
  }

  onStdout(handler: (data: Buffer | string) => void): void {
    this.stdoutHandlers.push(handler);
  }

  onStderr(_handler: (data: Buffer | string) => void): void {
    // HTTP has no separate stderr — errors come in the JSON response body.
    // Intentionally a no-op to maintain RProcess interface compatibility.
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  offStdout(handler: (data: Buffer | string) => void): void {
    const idx = this.stdoutHandlers.indexOf(handler);
    if (idx !== -1) this.stdoutHandlers.splice(idx, 1);
  }

  offStderr(_handler: (data: Buffer | string) => void): void {
    // No-op — no stderr handlers to remove.
  }

  kill(): void {
    this.alive = false;
    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  /**
   * Read a file from the remote server via GET /readfile.
   * Returns the raw binary body as a Buffer.
   */
  async readFile(remotePath: string): Promise<Buffer> {
    const encoded = encodeURIComponent(remotePath);
    const res = await this.httpRequest("GET", `/readfile?path=${encoded}`);
    if (res.status !== 200) {
      throw new Error(
        `Failed to read file ${remotePath}: HTTP ${res.status} - ${res.body.toString("utf-8")}`
      );
    }
    return res.body;
  }

  /**
   * Delete a file on the remote server via DELETE /unlink.
   */
  async unlinkFile(remotePath: string): Promise<void> {
    const encoded = encodeURIComponent(remotePath);
    const res = await this.httpRequest("DELETE", `/unlink?path=${encoded}`);
    if (res.status !== 200) {
      throw new Error(
        `Failed to unlink file ${remotePath}: HTTP ${res.status} - ${res.body.toString("utf-8")}`
      );
    }
  }

  /**
   * Perform a single HTTP request through an SSH forwardOut tunnel.
   * Each request gets its own stream — no connection reuse.
   */
  private async httpRequest(
    method: string,
    path: string,
    body?: string
  ): Promise<{ status: number; headers: Map<string, string>; body: Buffer }> {
    if (!this.sshClient || !this.alive) {
      throw new Error("SSH client not connected");
    }

    const client = this.sshClient;

    // Create a fresh TCP stream via forwardOut for this request
    const stream: ClientChannel = await new Promise<ClientChannel>(
      (resolve, reject) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          "127.0.0.1",
          this.port,
          (err, channel) => {
            if (err) {
              reject(new Error(`SSH forwardOut error: ${err.message}`));
            } else {
              resolve(channel);
            }
          }
        );
      }
    );

    try {
      // Build HTTP/1.1 request
      const contentLength = body ? Buffer.byteLength(body) : 0;
      let request = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nConnection: close\r\n`;
      if (body) {
        request += `Content-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n${body}`;
      } else {
        request += "\r\n";
      }

      // Write request and wait for full response
      return await new Promise<{
        status: number;
        headers: Map<string, string>;
        body: Buffer;
      }>((resolve, reject) => {
        const chunks: Buffer[] = [];

        stream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        stream.on("end", () => {
          const raw = Buffer.concat(chunks);
          try {
            const parsed = parseHttpResponse(raw);
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });

        stream.on("error", (err: Error) => {
          reject(new Error(`HTTP stream error: ${err.message}`));
        });

        stream.on("close", () => {
          // If we haven't resolved yet, the stream closed before 'end'
          if (chunks.length > 0) {
            const raw = Buffer.concat(chunks);
            try {
              const parsed = parseHttpResponse(raw);
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          }
        });

        stream.write(request);
        // Do NOT call stream.end() — Connection: close header tells the server
        // to close after responding. Calling stream.end() prematurely discards the response.
      });
    } finally {
      // Always close the stream
      try {
        stream.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Parse a raw HTTP/1.1 response Buffer into status, headers, and body.
 * Uses Buffer-level operations to safely handle binary content (e.g., PNG images).
 */
function parseHttpResponse(raw: Buffer): {
  status: number;
  headers: Map<string, string>;
  body: Buffer;
} {
  // Find \r\n\r\n separator at the Buffer level
  const separator = Buffer.from("\r\n\r\n");
  let headerEnd = -1;
  for (let i = 0; i <= raw.length - separator.length; i++) {
    if (raw[i] === separator[0]) {
      let match = true;
      for (let j = 1; j < separator.length; j++) {
        if (raw[i + j] !== separator[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        headerEnd = i;
        break;
      }
    }
  }

  if (headerEnd === -1) {
    throw new Error("Invalid HTTP response: no header/body separator");
  }

  // Parse header section as UTF-8 text
  const headerSection = raw.subarray(0, headerEnd).toString("utf-8");
  const lines = headerSection.split("\r\n");

  // Parse status line: HTTP/1.1 200 OK
  const statusLine = lines[0];
  const statusMatch = statusLine.match(/^HTTP\/1\.\d\s+(\d+)/);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP status line: ${statusLine}`);
  }
  const status = parseInt(statusMatch[1], 10);

  // Parse headers
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx !== -1) {
      const name = lines[i].substring(0, colonIdx).trim().toLowerCase();
      const value = lines[i].substring(colonIdx + 1).trim();
      headers.set(name, value);
    }
  }

  // Extract body as raw Buffer — safe for binary content (PNG, etc.)
  const bodyStart = headerEnd + 4; // skip \r\n\r\n (4 bytes)
  const body = raw.subarray(bodyStart);

  return { status, headers, body: Buffer.from(body) };
}
