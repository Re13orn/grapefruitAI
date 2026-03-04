# Grapefruit 安装、部署与使用手册（中文）

## 1. 适用范围

本文档适用于本仓库源码方式运行 Grapefruit（iOS/Android 动态分析平台），覆盖：

- 环境准备
- 本地安装
- 开发与生产部署
- MCP 接入
- 常见问题排查

## 2. 环境准备

## 2.1 主机环境

- 操作系统：macOS / Linux / Windows
- Node.js：`>= 22.18.0`
- Bun：建议使用最新版（项目主运行时）
- Git

建议先检查：

```bash
node -v
bun -v
git --version
```

## 2.2 移动端环境

- 目标设备需运行 `frida-server`，并可被 Frida 枚举到
- Android 设备建议同时安装 `adb`

Android 检查：

```bash
adb devices
frida-ls-devices
```

iOS 检查：

```bash
frida-ls-devices
```

## 3. 安装项目

```bash
git clone https://github.com/chichou/grapefruit.git
cd grapefruit
bun install
```

说明：

- 根目录 `bun install` 会执行 `prepare`，自动安装 `agent/` 与 `gui/` 依赖
- `agent`/`gui` 若触发构建，耗时会略长，属于正常现象

安装后可快速检查：

```bash
bun test src/tests/app.test.ts
```

## 4. 启动方式

## 4.1 开发模式（推荐）

一条命令启动前后端：

```bash
bun run dev:both
```

说明：

- 在 macOS/Linux 下该命令使用 `tmux` 拉起两个面板
- 若没有 `tmux`，请用 2 个终端手动启动（见下）

手动启动方式：

终端 1（后端）：

```bash
bun run dev
```

终端 2（前端）：

```bash
cd gui
bun run dev
```

默认访问：

- 前端（Vite）：`http://localhost:5173`
- 后端 API：`http://localhost:31337`

健康检查：

```bash
curl http://localhost:31337/api/version
```

## 4.2 生产模式（源码部署）

先构建静态资源与 agent：

```bash
bun run --cwd agent build
bun run --cwd gui build
```

再以生产模式启动后端（会托管 `gui/dist`）：

```bash
NODE_ENV=production HOST=0.0.0.0 PORT=31337 bun run start
```

## 4.3 npm 产物部署（可选）

```bash
bun run build:npm
NODE_ENV=production node dist/bin.mjs
```

## 4.4 单文件二进制部署（可选）

```bash
# 当前平台
bun run build:cli

# 多平台交叉构建
bun run build:all
```

产物在 `build/Release/`。

## 5. 基础使用流程

1. 启动服务并打开 Web UI  
2. 在设备列表确认目标设备在线  
3. 进入目标 App 工作区（Android/iOS）  
4. 在 `钩子`/`加密`/`日志` 等面板开启对应采集  
5. 执行 App 交互后，在结果面板查看参数、返回值与时间线记录  

## 6. MCP 接入（Codex / Claude Code）

## 6.1 获取状态与 Token

```bash
curl http://localhost:31337/api/mcp/status
```

开启 MCP：

```bash
curl -X PUT http://localhost:31337/api/mcp/status \
  -H 'content-type: application/json' \
  -d '{"enabled": true}'
```

轮换 Token：

```bash
curl -X POST http://localhost:31337/api/mcp/token/rotate
```

## 6.2 客户端配置

`/api/mcp/status` 返回中包含：

- `configSnippet`：通用 MCP JSON 配置（`type: "http"`）
- `codexAddCommand`：Codex CLI 一键接入命令
- `claudeConfigSnippet`：Claude Code 推荐 JSON 配置
- `antigravityConfigSnippet`：Antigravity 推荐 JSON 配置（通过 `mcp-remote` 桥接）
- `tokenEnvVar`：推荐的 Token 环境变量名

Codex CLI 示例：

```bash
export GRAPEFRUIT_MCP_TOKEN=<你的 token>
codex mcp add grapefruit --url http://localhost:31337/api/mcp --bearer-token-env-var GRAPEFRUIT_MCP_TOKEN
```

Claude Code 配置示例（复制 `claudeConfigSnippet`）：

```json
{
  "mcpServers": {
    "grapefruit": {
      "type": "http",
      "url": "http://localhost:31337/api/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Antigravity 配置示例（复制 `antigravityConfigSnippet`）：

```json
{
  "mcpServers": {
    "grapefruit": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:31337/api/mcp",
        "--header",
        "Authorization: Bearer ${GRAPEFRUIT_MCP_TOKEN}"
      ],
      "env": {
        "GRAPEFRUIT_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

## 6.3 当前 MCP 返回协议

`tools/call` 统一返回：

```json
{
  "status": "ok | error",
  "ok": true,
  "code": "OK",
  "message": "ok",
  "data": {},
  "artifacts": []
}
```

## 7. 常用环境变量

运行相关：

- `FRIDA_VERSION`：`16` 或 `17`（默认 `17`）
- `HOST`：监听地址（默认 `localhost`）
- `PORT`：服务端口（默认 `31337`）
- `FRIDA_TIMEOUT`：设备发现超时（毫秒）

数据目录覆盖：

- `IGF_STATE_DIR`
- `IGF_DATA_DIR`
- `IGF_CACHE_DIR`
- `IGF_CONFIG_DIR`
- `IGF_LOG_DIR`
- `IGF_TEMP_DIR`

## 8. 常见问题排查

## 8.1 设备看不到

- 检查 `frida-server` 是否在设备上运行
- 执行 `frida-ls-devices` 确认主机能看到设备
- 远程设备可通过 API 添加：

```bash
curl -X PUT http://localhost:31337/api/devices/remote/<host:port>
```

## 8.2 前端报 `ws proxy error` / `ECONNRESET`

- 先确认后端仍在运行（`/api/version` 是否 200）
- 目标进程重启或会话断开时，短暂报错可能是正常现象

## 8.3 Android 动作工具不可用（tap/swipe/back/home/input_text）

- 这些动作依赖 `adb`
- 确认 `adb` 在 PATH 中且 `adb devices` 可见目标设备

## 8.4 iOS 动作工具效果不稳定

- iOS 动作为应用内自动化（best-effort），不是系统级 HID 注入
- 建议目标 App 处于前台；必要时在 MCP 参数中显式传 `bundle`

## 9. 升级与重置

升级：

```bash
git pull
bun install
```

重置所有 Grapefruit 数据：

```bash
# 先预览
igf reset --dry-run

# 再执行
igf reset
```

会清理数据/缓存/配置/日志目录，不会清理浏览器本地缓存。
