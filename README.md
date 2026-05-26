# agentR

**English** | [中文](./README_CN.md)

MCP server for interactive R sessions. Let AI agents (Claude Code, OpenCode) execute R code in a persistent R session — local or remote via SSH.

**Two modes:**
- **Spawn mode** (default): AI starts a new R process and controls it exclusively
- **Attach mode**: AI connects to an existing R session (e.g., your RStudio Server session) for human-AI collaboration with shared variables

## Quick Start

### Install

```bash
git clone https://github.com/yuume/agentR.git
cd agentR
npm install
npm run build
```

### Claude Code

Add to your project's `.mcp.json`:

**Spawn mode** (AI creates a new remote R session via SSH):
```json
{
  "mcpServers": {
    "agentR": {
      "command": "node",
      "args": ["/path/to/agentR/dist/index.js"],
      "env": {
        "AGENT_R_SSH_HOST": "your-server.com",
        "AGENT_R_SSH_USER": "username",
        "AGENT_R_SSH_PASSWORD": "password"
      }
    }
  }
}
```

**Attach mode** (AI joins your existing RStudio Server session):
```json
{
  "mcpServers": {
    "agentR": {
      "command": "node",
      "args": ["/path/to/agentR/dist/index.js"],
      "env": {
        "AGENT_R_MODE": "attach",
        "AGENT_R_SSH_HOST": "your-server.com",
        "AGENT_R_SSH_USER": "username",
        "AGENT_R_SSH_PASSWORD": "password",
        "AGENT_R_ATTACH_PORT": "9876"
      }
    }
  }
}
```

### OpenCode

Same config format in your `opencode.json`:

```json
{
  "mcpServers": {
    "agentR": {
      "command": "node",
      "args": ["/path/to/agentR/dist/index.js"],
      "env": {
        "AGENT_R_SSH_HOST": "your-server.com",
        "AGENT_R_SSH_USER": "username",
        "AGENT_R_SSH_PASSWORD": "password"
      }
    }
  }
}
```

## Attach Mode — Human + AI Collaboration

Attach mode lets you and the AI agent share the same R session. Variables, data frames, and plots are shared in real-time.

### Step 1: Install R packages on the server

```r
install.packages(c("httpuv", "jsonlite"))
```

### Step 2: Upload agentR.R to the server

Copy `R/agentR.R` to your server (e.g., via SCP or RStudio file upload).

### Step 3: Start the server in RStudio Console

```r
source("agentR.R")
agentR_serve(9876)
```

RStudio console remains fully interactive — you can keep typing commands.

### Step 4: Configure MCP client with attach mode

Set `AGENT_R_MODE=attach` and `AGENT_R_ATTACH_PORT=9876` in your MCP config.

### Stop the server

```r
agentR_stop()
```

## Tools

| Tool | Description |
|------|-------------|
| `r_execute` | Execute R code in the persistent session |
| `r_inspect` | Inspect R objects (str, class, dim, summary, head, glimpse) |
| `r_plot` | Generate plots and return as PNG images |
| `r_install_packages` | Install R packages |
| `r_session_info` | Get R version, loaded packages, working directory |
| `r_reset` | Reset the R session (kill + restart) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_R_MODE` | `spawn` | `spawn` = new R process, `attach` = join existing session |
| `AGENT_R_PATH` | `R` | Path to R binary |
| `AGENT_R_TIMEOUT` | `60000` | Execution timeout in ms |
| `AGENT_R_SSH_HOST` | — | SSH host (enables SSH mode) |
| `AGENT_R_SSH_PORT` | `22` | SSH port |
| `AGENT_R_SSH_USER` | — | SSH username |
| `AGENT_R_SSH_PASSWORD` | — | SSH password |
| `AGENT_R_SSH_KEY` | — | SSH private key (file path or content) |
| `AGENT_R_SSH_PASSPHRASE` | — | Passphrase for private key |
| `AGENT_R_ATTACH_PORT` | `9876` | Port for attach mode (httpuv server) |

## Architecture

```
Spawn Mode                          Attach Mode
┌────────────────┐                 ┌─────────────────────┐
│  AI Agent      │                 │  Human (RStudio)    │
│  (MCP client)  │                 │  ┌───────────────┐  │
└───────┬────────┘                 │  │ R console     │  │
        │                          │  │ httpuv :9876  │  │
        ▼                          │  └───────┬───────┘  │
┌────────────────┐                 └──────────┼──────────┘
│  agentR MCP    │  SSH tunnel                │
│  server        │◄───────────────────────────┤
│  (Node.js)     │                            │
└───────┬────────┘                            │
        │ SSH exec ("R")        SSH forwardOut │
        ▼                                     ▼
┌────────────────┐                 ┌────────────────────┐
│  New R process │                 │  Existing R session│
│  (exclusive)   │                 │  (shared)          │
└────────────────┘                 └────────────────────┘
```

## Requirements

- Node.js >= 18
- R >= 4.0 (on local or remote machine)
- For attach mode: `httpuv` and `jsonlite` R packages
- For SSH: remote server accessible via password or key auth

## License

MIT
