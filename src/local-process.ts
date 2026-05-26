/**
 * LocalRProcess — wraps a Node.js ChildProcess as an RProcess.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { RProcess } from "./r-process.js";

export class LocalRProcess implements RProcess {
  private child: ChildProcess | null = null;

  /**
   * Spawn a local R process.
   */
  spawn(rPath: string, args: string[]): void {
    this.child = spawn(rPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  writeStdin(data: string): void {
    this.child?.stdin?.write(data);
  }

  onStdout(handler: (data: Buffer | string) => void): void {
    this.child?.stdout?.on("data", handler);
  }

  onStderr(handler: (data: Buffer | string) => void): void {
    this.child?.stderr?.on("data", handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.child?.on("exit", handler);
  }

  offStdout(handler: (data: Buffer | string) => void): void {
    this.child?.stdout?.removeListener("data", handler);
  }

  offStderr(handler: (data: Buffer | string) => void): void {
    this.child?.stderr?.removeListener("data", handler);
  }

  kill(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }

  isAlive(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /** Read-only access to the underlying ChildProcess (for cleanup etc.) */
  get underlying(): ChildProcess | null {
    return this.child;
  }
}
