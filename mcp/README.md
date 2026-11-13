# MCP 服务接入指南

`mcp/server.mjs` 是零依赖的 stdio MCP 服务，让 Codex、Workbuddy 等 MCP 客户端能够：

1. **自动安装**：从 GitHub 克隆本工程 → 下载前端资源包（Release，约 1.3 GB）→ `npm ci` → `npm run build` → 写入模型配置 → 启动本地服务；
2. **调用生成能力**：文生图、图生图、文生3D、图生3D（真实模型调用，异步任务）；
3. **打开页面**：返回可供内嵌浏览器打开的工作台 URL。

要求：Node.js ≥ 24、`git`、`tar`（macOS / Linux / Win10+ 自带）。浮雕功能另需 `python3`（可选）。

## 快速开始

```bash
git clone https://github.com/roryyu/zhubao.git
```

然后在 MCP 客户端里把命令指向克隆目录中的 `mcp/server.mjs`，并通过 `env` 注入模型配置。首次调用 `setup`（或任意生成工具）时，MCP 会把运行实例安装到 `~/.cjzbai-mcp/zhubao`（可用 `CJZBAI_PROJECT_DIR` 改到已有 checkout，复用现有 `.env` 与数据）。

### Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.cjzbai]
command = "node"   # 建议写 node 绝对路径，避免 nvm 环境差异
args = ["/absolute/path/zhubao/mcp/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 1800   # 首次安装需下载约 1.3 GB 资源，放宽工具超时

[mcp_servers.cjzbai.env]
IMAGE_BASE_URL = "https://your-image-endpoint/v1"
IMAGE_API_KEY = "sk-..."
IMAGE_MODEL = "your-image-model"
IMAGE_API_STYLE = "auto"        # auto / images / chat / dashscope
CHAT_BASE_URL = "https://your-chat-endpoint/v1"
CHAT_API_KEY = "sk-..."
CHAT_MODEL = "your-vision-chat-model"   # 3D 建模需要支持视觉的对话模型
CHAT_VISION = "true"
```

### Workbuddy / 通用 MCP 客户端（JSON 配置）

```json
{
  "mcpServers": {
    "cjzbai": {
      "command": "node",
      "args": ["/absolute/path/zhubao/mcp/server.mjs"],
      "env": {
        "IMAGE_BASE_URL": "https://your-image-endpoint/v1",
        "IMAGE_API_KEY": "sk-...",
        "IMAGE_MODEL": "your-image-model",
        "IMAGE_API_STYLE": "auto",
        "CHAT_BASE_URL": "https://your-chat-endpoint/v1",
        "CHAT_API_KEY": "sk-...",
        "CHAT_MODEL": "your-vision-chat-model",
        "CHAT_VISION": "true"
      }
    }
  }
}
```

模型接口的协议选择、千问 DashScope 原生协议等细节见工程根目录 [模型配置.md](../模型配置.md)。密钥只写入运行实例的本机 `.env`，不会进入网页或日志。

### Agent Skill（可选）

[SKILL.md](SKILL.md) 是配套的 Agent Skill，描述异步任务轮询、参考图上传、结果交付与能力边界的调用规范。复制到客户端的技能目录即可，例如 Codex：`~/.codex/skills/cjzbai/SKILL.md`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CJZBAI_PROJECT_DIR` | `~/.cjzbai-mcp/zhubao` | 运行实例目录；不存在时自动克隆。指向已有 checkout 可复用其 `.env`、历史任务与生成结果 |
| `CJZBAI_REPO_URL` | `https://github.com/roryyu/zhubao.git` | 克隆来源 |
| `CJZBAI_ASSETS_URL` | Release `frontend-assets-v1/frontend-assets.tar` | 前端资源包；也可填本地 tar 路径离线安装 |
| `CJZBAI_PORT` | `4174` | 本地服务端口（仅监听 127.0.0.1） |
| `CJZBAI_STATE_DIR` | `~/.cjzbai-mcp` | pid / 服务日志 / 资源包缓存目录 |
| `IMAGE_*` / `CHAT_*` / `MODEL3D_*` | — | 与 [.env.example](../.env.example) 同名键，透传写入运行实例 `.env`；未提供时保留已有 `.env` 不动 |

`MODEL3D_*` 缺省沿用 `CHAT_*`。文生/图生 3D 需要对话模型支持视觉输入（图片分析 + 渲染自评）。

## 工具列表

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `setup` | `relief?` | 幂等安装并启动；`relief=true` 额外准备浮雕环境 |
| `status` | — | 安装/运行状态与当前模型配置（不触发安装） |
| `text_to_image` | `prompt`, `aspect_ratio?`, `size?(1K/2K)`, `wait_seconds?` | 文生图 |
| `image_to_image` | `prompt`, `images[1-4]`, `aspect_ratio?`, `size?`, `wait_seconds?` | 图生图；图片支持本地路径、URL |
| `text_to_3d` | `prompt`, `wait_seconds?` | 文生3D，导出 GLB/STL/DXF/JSON |
| `image_to_3d` | `image`, `prompt?`, `wait_seconds?` | 图生3D，导出 GLB/STL/DXF/JSON |
| `get_task` | `task_id`, `wait_seconds?` | 查询任务；成功时返回结果 URL 与本地文件路径 |
| `list_tasks` | `limit?` | 最近任务历史（含网页端任务） |
| `open_workspace` | `open_browser?` | 返回内嵌浏览器可打开的工作台 URL；`open_browser=true` 同时弹系统浏览器 |

### 异步任务约定

- 生成工具默认立即返回 `task_id`，用 `get_task` 轮询；`wait_seconds`（0–110）可同步等待。图片约 1 分钟，3D 多阶段管线可能需要数分钟。
- 本地服务同一时间只允许一个生成任务；忙时提交会返回进行中任务的 `task_id`。
- 结果文件在运行实例 `data/generated/`；任务历史在 `data/tasks.json`，重启不丢。
- 3D 输出为参数化实体概念模型（车削/拉伸/扫掠/布尔运算 + 渲染自评），非加工级 CAD，能力边界见主 README。

## 运行与排障

- 本地服务由 MCP 以独立进程启动，MCP 退出后继续运行；日志在 `CJZBAI_STATE_DIR/server-<port>.log`。
- 端口被其他程序占用时设置 `CJZBAI_PORT`；若端口上已有本项目服务（例如手动 `npm start`），MCP 直接复用，不会杀掉它。此时修改模型配置需手动重启该服务。
- 前端资源包下载失败可重试 `setup`（断点步骤幂等）；离线环境把 `CJZBAI_ASSETS_URL` 指向本地 tar。
- 手动验证协议：`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs`。