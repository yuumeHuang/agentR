import {
  DONE_MARKER,
  CONT_MARKER,
  parseOutput,
  buildStartupCode,
  MAX_OUTPUT_LENGTH,
} from "./output-parser.js";
import type { RProcess } from "./r-process.js";
import { LocalRProcess } from "./local-process.js";
import { SshRProcess, type SshConfig } from "./ssh-process.js";
import { HttpRProcess } from "./http-process.js";
import type { AttachConfig } from "./attach-config.js";

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  error: string | null;
  truncated: boolean;
  incomplete: boolean;
}

export interface SessionOptions {
  rPath?: string; // Path to R binary (default: "R")
  timeout?: number; // Default execution timeout in ms (default: 60000)
  maxOutputLength?: number; // Max output chars before truncation (default: 10000)
  maxTotalTimeout?: number; // Absolute timeout cap in ms regardless of output activity (default: 600000 = 10min)
  ssh?: SshConfig; // If provided, connect to R via SSH instead of local process
  attach?: AttachConfig; // If provided, attach to existing R session via HTTP
}

type PendingExecution = {
  resolve: (result: ExecutionResult) => void;
  reject: (reason: Error) => void;
  stdoutBuf: string;
  stderrBuf: string;
  timer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
};

const R_ARGS_LOCAL = ["--no-save", "--no-restore", "--no-readline", "--slave"];
const R_ARGS_SSH = ["--no-save", "--no-restore", "--no-readline"];

/**
 * Manages a persistent R process for interactive code execution.
 *
 * Works with both local R (child_process) and remote R (SSH).
 * The transport layer is abstracted via the RProcess interface.
 *
 * Key design decisions:
 * - Uses custom prompt markers to detect when R finishes execution
 * - Serializes all execute() calls via a Promise chain (queue)
 * - Auto-restarts the R process if it crashes
 * - Handles incomplete expressions (R waiting for more input)
 */
export class SessionManager {
  private proc: RProcess | null = null;
  private startupPromise: Promise<void> | null = null;
  private executionQueue: Promise<ExecutionResult> = Promise.resolve({
    stdout: "",
    stderr: "",
    error: null,
    truncated: false,
    incomplete: false,
  });
  private pendingExecution: PendingExecution | null = null;

  private readonly rPath: string;
  private readonly defaultTimeout: number;
  private readonly maxOutputLength: number;
  private readonly maxTotalTimeout: number;
  private readonly sshConfig: SshConfig | undefined;
  private readonly attachConfig: AttachConfig | undefined;

  constructor(options?: SessionOptions) {
    this.rPath = options?.rPath ?? "R";
    this.defaultTimeout = options?.timeout ?? 60000;
    this.maxOutputLength = options?.maxOutputLength ?? MAX_OUTPUT_LENGTH;
    this.maxTotalTimeout = options?.maxTotalTimeout ?? 600000; // 10 minutes hard cap
    this.sshConfig = options?.ssh;
    this.attachConfig = options?.attach;
  }

  /**
   * Start (or restart) the R process and wait for initialization.
   */
  async start(): Promise<void> {
    // Kill existing process if any
    if (this.proc && this.proc.isAlive()) {
      return;
    }

    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }

    this.startupPromise = new Promise<void>(async (resolve, reject) => {
      try {
        if (this.attachConfig) {
          // Attach mode — connect to existing R session via HTTP through SSH tunnel.
          // No startup code or marker detection needed — HTTP responses are synchronous.
          const httpProc = new HttpRProcess();
          await httpProc.connect(this.attachConfig.ssh, this.attachConfig.port);
          this.proc = httpProc;
          resolve();
        } else {
          // Spawn mode (SSH or local) — start new R process
          if (this.sshConfig) {
            // SSH mode — no --slave, PTY handles output
            const sshProc = new SshRProcess();
            await sshProc.connectAndExec(this.sshConfig, this.rPath, R_ARGS_SSH);
            this.proc = sshProc;
          } else {
            // Local mode
            const localProc = new LocalRProcess();
            localProc.spawn(this.rPath, R_ARGS_LOCAL);
            this.proc = localProc;
          }

          // Wait for the first DONE_MARKER (from startup code)
          const initPromise = new Promise<void>((initResolve, initReject) => {
            let initBuf = "";

            const onStdout = (chunk: Buffer | string): void => {
              initBuf += chunk.toString("utf-8");

              if (initBuf.includes(DONE_MARKER)) {
                this.proc!.offStdout(onStdout);
                this.proc!.offStderr(onStderr);
                initResolve();
              }
            };

            const onStderr = (_chunk: Buffer | string): void => {
              // Drain stderr during startup but don't block
            };

            const onExit = () => {
              if (!this.proc) return; // already cleaned up by reset/shutdown
              this.proc.offStdout(onStdout);
              this.proc.offStderr(onStderr);
              this.proc = null;
              this.startupPromise = null;
              if (!initBuf.includes(DONE_MARKER)) {
                initReject(new Error("R process exited during startup"));
              }
            };

            this.proc!.onStdout(onStdout);
            this.proc!.onStderr(onStderr);
            this.proc!.onExit(onExit);

            // Send startup code
            this.proc!.writeStdin(buildStartupCode() + "\n");
          });

          await initPromise;
          resolve();
        }
      } catch (err) {
        this.proc = null;
        this.startupPromise = null;
        reject(
          new Error(
            `Failed to start R: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });

    return this.startupPromise;
  }

  /**
   * Execute R code. Calls are serialized — they run one at a time.
   * Auto-starts the R session if needed.
   */
  execute(code: string, timeout?: number): Promise<ExecutionResult> {
    this.executionQueue = this.executionQueue.then(() =>
      this._executeInternal(code, timeout)
    );
    return this.executionQueue;
  }

  /**
   * Internal execution — must only run one at a time.
   */
  private async _executeInternal(
    code: string,
    timeoutOverride?: number
  ): Promise<ExecutionResult> {
    // Auto-start if process is dead
    if (!this.proc || !this.proc.isAlive()) {
      await this.start();
    }

    // After start, double-check
    if (!this.proc) {
      return {
        stdout: "",
        stderr: "",
        error: "R process is not available",
        truncated: false,
        incomplete: false,
      };
    }

    const proc = this.proc;
    const effectiveTimeout = timeoutOverride ?? this.defaultTimeout;

    return new Promise<ExecutionResult>((resolve, reject) => {
      const stdoutBuf: string[] = [];
      const stderrBuf: string[] = [];
      let settled = false;
      let continuationAttempts = 0;
      const maxContinuationAttempts = 3;

      // Sliding window timeout: reset on each output chunk.
      // hardDeadline is the absolute wall-clock cap (maxTotalTimeout).
      // idleTimer fires if no output arrives for effectiveTimeout ms.
      const startTime = Date.now();
      const hardDeadline = startTime + this.maxTotalTimeout;

      const cleanup = (): void => {
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        if (pending.hardTimer) {
          clearTimeout(pending.hardTimer);
          pending.hardTimer = null;
        }
        proc.offStdout(onStdout);
        proc.offStderr(onStderr);
        this.pendingExecution = null;
      };

      const finish = (result: ExecutionResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      /** Reset the idle timer. Called each time R produces output. */
      const resetIdleTimer = (): void => {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.timer = setTimeout(onIdleTimeout, effectiveTimeout);
      };

      /** Fires when no output has arrived for effectiveTimeout ms. */
      const onIdleTimeout = (): void => {
        if (settled) return;
        // Try to cancel the running command
        proc.writeStdin("\n");
        // Give R a moment to respond, then force-finish
        setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const combined = stdoutBuf.join("");
          const parsed = parseOutput(combined);
          const stderrText = stderrBuf.join("").replace(/\r/g, "");
          resolve({
            stdout: parsed.output,
            stderr: stderrText,
            error: `Execution timed out after ${effectiveTimeout}ms of inactivity`,
            truncated: parsed.truncated,
            incomplete: false,
          });
        }, 500);
      };

      /** Fires when hardDeadline is reached regardless of activity. */
      const onHardTimeout = (): void => {
        if (settled) return;
        proc.writeStdin("\n");
        setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const combined = stdoutBuf.join("");
          const parsed = parseOutput(combined);
          const stderrText = stderrBuf.join("").replace(/\r/g, "");
          const elapsed = Date.now() - startTime;
          resolve({
            stdout: parsed.output,
            stderr: stderrText,
            error: `Execution timed out after ${elapsed}ms (hard limit: ${this.maxTotalTimeout}ms)`,
            truncated: parsed.truncated,
            incomplete: false,
          });
        }, 500);
      };

      const pending: PendingExecution = {
        resolve: finish,
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
        stdoutBuf: "",
        stderrBuf: "",
        timer: null,
        hardTimer: null,
      };

      this.pendingExecution = pending;

      const onStdout = (chunk: Buffer | string): void => {
        const text = chunk.toString("utf-8");
        stdoutBuf.push(text);
        const combined = stdoutBuf.join("");

        // Reset idle timer on each output chunk — R is still working
        resetIdleTimer();

        if (combined.includes(DONE_MARKER)) {
          // Normal completion
          const parsed = parseOutput(combined);
          const stderrText = stderrBuf.join("").replace(/\r/g, "");
          finish({
            stdout: parsed.output,
            stderr: stderrText,
            error: parsed.error,
            truncated: parsed.truncated,
            incomplete: false,
          });
        } else if (combined.includes(CONT_MARKER)) {
          // R wants more input — incomplete expression
          continuationAttempts++;

          if (continuationAttempts >= maxContinuationAttempts) {
            // Give up — send a syntax-breaking input to cancel
            proc.writeStdin("NULL\n");
          } else {
            // Send newline to try to complete the expression
            proc.writeStdin("\n");
          }
        }
      };

      const onStderr = (chunk: Buffer | string): void => {
        stderrBuf.push(chunk.toString("utf-8"));
        // Reset idle timer on stderr too — progress bars often write to stderr
        resetIdleTimer();
      };

      proc.onStdout(onStdout);
      proc.onStderr(onStderr);

      // Set idle timer (resets on each output chunk)
      pending.timer = setTimeout(onIdleTimeout, effectiveTimeout);

      // Set hard deadline timer (never resets)
      const msUntilHard = Math.max(0, hardDeadline - Date.now());
      pending.hardTimer = setTimeout(onHardTimeout, msUntilHard);

      // Send the code.
      // For SSH/PTY mode, multi-line code can break because the PTY processes
      // each line as a separate input. Convert real newlines (0x0A) to semicolons.
      // We use a regex that only matches actual newline characters, not the
      // two-character sequence \n that appears in R string literals.
      // In attach mode, HTTP handles multi-line code natively — no compression.
      const effectiveCode = this.sshConfig && !this.attachConfig
        ? code.replace(/\r?\n/g, "; ")
        : code;
      proc.writeStdin(effectiveCode + "\n");
    });
  }

  /**
   * Get the current working directory from the R session.
   */
  async getWorkingDirectory(): Promise<string> {
    const result = await this.execute('cat(getwd(), "\n")');
    if (result.error) {
      throw new Error(`Failed to get working directory: ${result.error}`);
    }
    return result.stdout.trim();
  }

  /**
   * Kill the current R process and start a fresh one.
   */
  async reset(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.startupPromise = null;
    }
    await this.start();
  }

  /**
   * Check if the R process is still running.
   */
  isAlive(): boolean {
    return this.proc !== null && this.proc.isAlive();
  }

  /**
   * Check if the session is connected via SSH.
   */
  isSsh(): boolean {
    return this.sshConfig !== undefined;
  }

  /**
   * Read a file — from local filesystem or remote server via SFTP.
   * Used by the plot tool to retrieve generated PNG files.
   */
  async readFile(path: string): Promise<Buffer> {
    if (this.attachConfig && this.proc && "readFile" in this.proc) {
      return (this.proc as import("./http-process.js").HttpRProcess).readFile(path);
    }
    if (this.sshConfig && this.proc && "readFile" in this.proc) {
      return (this.proc as import("./ssh-process.js").SshRProcess).readFile(path);
    }
    // Local mode — read from local filesystem
    const { readFile: fsReadFile } = await import("node:fs/promises");
    return fsReadFile(path);
  }

  /**
   * Delete a file — locally or on remote server via SFTP.
   */
  async unlinkFile(path: string): Promise<void> {
    if (this.attachConfig && this.proc && "unlinkFile" in this.proc) {
      return (this.proc as import("./http-process.js").HttpRProcess).unlinkFile(path);
    }
    if (this.sshConfig && this.proc && "unlinkFile" in this.proc) {
      return (this.proc as import("./ssh-process.js").SshRProcess).unlinkFile(path);
    }
    // Local mode — delete from local filesystem
    const { unlink: fsUnlink } = await import("node:fs/promises");
    await fsUnlink(path);
  }

  /**
   * Shut down the R process. Does not restart.
   */
  async shutdown(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.startupPromise = null;
    }
  }
}
