# MCP 服务接入指南

`mcp/server.mjs` 是零依赖的 stdio MCP 服务，让 Codex、Workbuddy 等 MCP 客户端能够：

1. **自动安装**：从 GitHub 克隆本工程 → `npm ci` → `npm run build` → 启动本地服务（构建骨架随仓库分发，约 24 MB，无需额外下载）；
2. **提供生成链路**：文生图、图生图、文生3D、图生3D 的提示词、参考图与本地几何算力；
3. **打开页面**：返回可供内嵌浏览器打开的工作台 URL。

## 职责边界

**MCP 只提供工具，不调用任何大模型，也不接收模型密钥。**

- 文生图 / 图生图：`prepare_image` 返回出图提示词与参考图 URL → **客户端 Agent 用自己的图像模型出图** → `submit_image` 回传，服务端校验保存并登记历史。
- 文生3D / 图生3D：`prepare_3d` 返回建模提示词 → **客户端 Agent 用自己的大模型输出建模 JSON** → `submit_3d` 回传 → 服务端本地构建几何、校验、渲染导出；可能返回修正或自评提示词，循环直到完成。
- 工程自带的网页工作台（`/workspace/*`）仍使用工程自己的 `.env` 模型配置，那是网页端的独立功能：**MCP 不读取、不写入、不改造该 `.env`**。

要求：Node.js ≥ 24、`git`、`tar`（macOS / Linux / Win10+ 自带）。3D 自评修正另需 Python 几何环境（`setup` 传 `relief=true` 准备，可选）。

## 快速开始

```bash
git clone https://github.com/roryyu/zhubao.git
```

然后在 MCP 客户端里把命令指向克隆目录中的 `mcp/server.mjs`。首次调用 `setup`（或任意工具）时，MCP 会把运行实例安装到 `~/.cjzbai-mcp/zhubao`（可用 `CJZBAI_PROJECT_DIR` 改到已有 checkout，复用其历史任务与生成结果）。不需要配置任何模型地址或密钥。

### Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.cjzbai]
command = "node"   # 建议写 node 绝对路径，避免 nvm 环境差异
args = ["/absolute/path/zhubao/mcp/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 1800   # 首次安装需 npm ci 与构建前端，放宽工具超时
```

不需要 `env` 模型配置。只有要换目录或端口时才加：

```toml
[mcp_servers.cjzbai.env]
CJZBAI_PROJECT_DIR = "/path/to/zhubao"
CJZBAI_PORT = "4174"
```

### Workbuddy / 通用 MCP 客户端（JSON 配置）

```json
{
  "mcpServers": {
    "cjzbai": {
      "command": "node",
      "args": ["/absolute/path/zhubao/mcp/server.mjs"]
    }
  }
}
```

不需要填写模型地址或 API Key。[模型配置.md](../模型配置.md) 只与网页工作台有关，MCP 链路用不到。

### Agent Skill（可选）

[SKILL.md](SKILL.md) 是配套的 Agent Skill，描述往返调用顺序、参考图回传、结果交付与能力边界。复制到客户端的技能目录即可，例如 Codex：`~/.codex/skills/cjzbai/SKILL.md`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CJZBAI_PROJECT_DIR` | `~/.cjzbai-mcp/zhubao` | 运行实例目录；不存在时自动克隆。指向已有 checkout 可复用其历史任务与生成结果 |
| `CJZBAI_REPO_URL` | `https://github.com/roryyu/zhubao.git` | 克隆来源 |
| `CJZBAI_ASSETS_URL` | （未设置） | 可选：额外资源包地址（GitHub Release 或本地 tar）。构建骨架已在仓库中，一般不需要；仅当要补齐缺失资源或额外下发原站 media 时才设 |
| `CJZBAI_PORT` | `4174` | 本地服务端口（仅监听 127.0.0.1） |
| `CJZBAI_STATE_DIR` | `~/.cjzbai-mcp` | pid / 服务日志 / 资源包缓存目录 |

这些变量只决定「装在哪、从哪装、开哪个端口」，与模型无关；MCP 没有任何模型配置项。

## 工具列表

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `setup` | `relief?` | 幂等安装并启动；`relief=true` 额外准备 Python 几何环境（3D 自评渲染用） |
| `status` | — | 安装/运行状态（不触发安装，不含密钥） |
| `prepare_image` | `prompt`, `images?`, `aspect_ratio?`, `size?` | 返回出图提示词与参考图 URL |
| `submit_image` | `task_id`, `image` | 回传你生成的图片（路径 / URL / data URL），保存并返回展示 URL |
| `prepare_3d` | `prompt?`, `image?`, `mode?`, `refine_rounds?` | 返回建模或结构分析提示词 |
| `submit_3d` | `task_id`, `output` | 回传你的模型输出的 JSON；返回下一轮提示词或最终 GLB/STL/DXF/JSON |
| `get_task` | `task_id`, `wait_seconds?` | 查询任务状态与结果（可同步等待 0–110 秒） |
| `list_tasks` | `limit?` | 最近任务历史（含网页端任务） |
| `open_workspace` | `open_browser?` | 返回内嵌浏览器可打开的工作台 URL；`open_browser=true` 同时弹系统浏览器 |

### 往返约定

- `prepare_*` / `submit_*` 是同步往返：每次 `submit_3d` 立即返回下一阶段提示词或最终结果；Agent 会话 30 分钟无回传自动作废。
- 本地服务同一时间只允许一个生成任务；忙时提交会返回进行中任务的 `task_id`。
- 结果文件在运行实例 `data/generated/`；任务历史在 `data/tasks.json`，重启不丢。
- 3D 输出为参数化实体概念模型（车削/拉伸/扫掠/布尔运算 + 渲染自评），非加工级 CAD，能力边界见主 README。
- 完成后用返回的 `view_url` 展示：图片 `/workspace/2006`，3D `/workspace/2011`。

## 运行与排障

- 本地服务由 MCP 以独立进程启动，MCP 退出后继续运行；日志在 `CJZBAI_STATE_DIR/server-<port>.log`。
- 端口被其他程序占用时设置 `CJZBAI_PORT`；若端口上已有本项目服务（例如手动 `npm start`），MCP 直接复用，不会杀掉它。
- 前端骨架（`captured/index.html` + `assets`）随仓库分发，`setup` 不需要下载外部资源；原站 `captured/media` 缺失只影响页面上的作品/宣传素材展示，不影响出图与建模。若自行准备了资源包，可把 `CJZBAI_ASSETS_URL` 指向它。
- 手动验证协议：`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs`。