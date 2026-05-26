/**
 * Abstraction over an R process — works for both local child_process
 * and remote SSH sessions. SessionManager only depends on this interface.
 */

export interface RProcess {
  /** Write data to the process stdin */
  writeStdin(data: string): void;

  /** Register a handler for stdout data */
  onStdout(handler: (data: Buffer | string) => void): void;

  /** Register a handler for stderr data */
  onStderr(handler: (data: Buffer | string) => void): void;

  /** Register a handler for process exit */
  onExit(handler: (code: number | null) => void): void;

  /** Remove a previously registered stdout handler */
  offStdout(handler: (data: Buffer | string) => void): void;

  /** Remove a previously registered stderr handler */
  offStderr(handler: (data: Buffer | string) => void): void;

  /** Kill the process / close the connection */
  kill(): void;

  /** Check if the process is still alive */
  isAlive(): boolean;
}
