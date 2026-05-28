# agentR

[English](./README.md) | **中文**

MCP server，让 AI agent 在持久化的 R session 中执行代码——支持本地和 SSH 远程。

**两种模式：**
- **Spawn 模式**（默认）：AI 新建一个 R 进程，独占使用
- **Attach 模式**：AI 接入已有的 R session（如你的 RStudio Server），实现人机协作，变量共享

## 推荐客户端：CodeWhale

[CodeWhale](https://github.com/Hmbown/CodeWhale) 是基于 Rust 的编程 Agent，对 MCP 有完善的一等支持，是 agentR 的推荐客户端。

### 安装 agentR

```bash
git clone https://github.com/yuumeHuang/agentR.git
cd agentR
npm install
npm run build
```

### 在 CodeWhale 中配置

#### 方式 A：TUI 内快速配置

启动 CodeWhale TUI，运行：

```
/mcp add stdio agentR node --arg "/absolute/path/to/agentR/dist/index.js"
```

设置环境变量：

```
/mcp env agentR AGENT_R_SSH_HOST your-server.com
/mcp env agentR AGENT_R_SSH_USER username
/mcp env agentR AGENT_R_SSH_PASSWORD password
```

#### 方式 B：编辑配置文件

编辑 `~/.deepseek/mcp.json`：

**Spawn 模式**（AI 通过 SSH 新建远程 R 进程）：

```json
{
  "servers": {
    "agentR": {
      "command": "node",
      "args": ["/absolute/path/to/agentR/dist/index.js"],
      "env": {
        "AGENT_R_SSH_HOST": "your-server.com",
        "AGENT_R_SSH_USER": "username",
        "AGENT_R_SSH_PASSWORD": "password"
      }
    }
  }
}
```

**Attach 模式**（AI 接入你正在使用的 RStudio Server session）：

```json
{
  "servers": {
    "agentR": {
      "command": "node",
      "args": ["/absolute/path/to/agentR/dist/index.js"],
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

#### 验证配置

```
/mcp list            # 应显示 agentR 为已启用
/mcp tools agentR    # 应列出 6 个工具：r_execute, r_inspect, r_plot 等
```

## Attach 模式 — 人机协作

Attach 模式让你和 AI agent 共享同一个 R session，变量、数据框、图表实时共享。

### 第一步：在服务器上安装 R 包

```r
install.packages(c("httpuv", "jsonlite"))
```

### 第二步：上传 agentR.R

将 `R/agentR.R` 上传到服务器（SCP 或通过 RStudio 文件上传）。

### 第三步：在 RStudio Console 中启动

```r
source("agentR.R")
agentR_serve(9876)
```

RStudio 控制台保持完全可交互——你可以继续输入命令。

### 第四步：配置 CodeWhale attach 模式

使用上面的 attach 模式配置，设置 `AGENT_R_MODE=attach` 和 `AGENT_R_ATTACH_PORT=9876`。

### 停止服务

```r
agentR_stop()
```

## 工具列表

| 工具 | 说明 |
|------|------|
| `r_execute` | 在持久化 session 中执行 R 代码 |
| `r_inspect` | 检查 R 对象（str、class、dim、summary、head、glimpse） |
| `r_plot` | 生成图表并返回 PNG 图片 |
| `r_install_packages` | 安装 R 包 |
| `r_session_info` | 获取 R 版本、已加载包、工作目录 |
| `r_reset` | 重置 R session（终止 + 重启） |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_R_MODE` | `spawn` | `spawn` = 新建 R 进程，`attach` = 接入已有 session |
| `AGENT_R_PATH` | `R` | R 可执行文件路径 |
| `AGENT_R_TIMEOUT` | `60000` | 空闲超时（毫秒）——每次收到输出自动重置（滑动窗口） |
| `AGENT_R_MAX_TOTAL_TIMEOUT` | `600000` | 绝对最大执行时间（毫秒），不因输出活动而延长 |
| `AGENT_R_SSH_HOST` | — | SSH 主机（设置后启用 SSH 模式） |
| `AGENT_R_SSH_PORT` | `22` | SSH 端口 |
| `AGENT_R_SSH_USER` | — | SSH 用户名 |
| `AGENT_R_SSH_PASSWORD` | — | SSH 密码 |
| `AGENT_R_SSH_KEY` | — | SSH 私钥（文件路径或内容） |
| `AGENT_R_SSH_PASSPHRASE` | — | 私钥密码 |
| `AGENT_R_ATTACH_PORT` | `9876` | Attach 模式端口（httpuv 服务） |

## 架构

```
Spawn 模式                              Attach 模式
┌────────────────┐                     ┌─────────────────────┐
│  AI Agent      │                     │  人类 (RStudio)     │
│  (MCP 客户端)  │                     │  ┌───────────────┐  │
└───────┬────────┘                     │  │ R console     │  │
        │                              │  │ httpuv :9876  │  │
        ▼                              │  └───────┬───────┘  │
┌────────────────┐                     └──────────┼──────────┘
│  agentR MCP    │  SSH tunnel                    │
│  server        │◄───────────────────────────────┤
│  (Node.js)     │                                │
└───────┬────────┘                                │
        │ SSH exec ("R")              SSH forwardOut │
        ▼                                         ▼
┌────────────────┐                     ┌────────────────────┐
│  新 R 进程     │                     │  已有的 R session  │
│  (独占)        │                     │  (共享)            │
└────────────────┘                     └────────────────────┘
```

## 系统要求

- Node.js >= 18
- R >= 4.0（本地或远程服务器）
- Attach 模式需要：R 包 `httpuv` 和 `jsonlite`
- SSH 模式需要：远程服务器支持密码或密钥认证

## License

MIT
