import type { SshConfig } from "./ssh-process.js";

export interface AttachConfig {
  /** Port on the remote server where httpuv R server is listening */
  port: number;
  /** SSH connection config to reach the remote server */
  ssh: SshConfig;
}
