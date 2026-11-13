---
name: cjzbai-jewelry
description: 通过 cjzbai MCP 服务生成珠宝设计图与 3D 概念模型（文生图、图生图、文生3D、图生3D），并打开本地工作台页面。当用户要求设计首饰/戒指/吊坠/手镯效果图、上传参考图修改材质或款式、生成珠宝 3D 模型（GLB/STL/DXF）、或打开无觉珠宝工作台时使用。
---

# 无觉珠宝 AI · MCP 调用技能

本技能配合 `cjzbai` MCP 服务使用（服务脚本为本仓库 `mcp/server.mjs`，注册方式见 `mcp/README.md`）。
工具名在不同客户端可能带前缀（如 `mcp__cjzbai__text_to_image`），按语义匹配即可。

## 首次使用

1. 调 `status`：确认 `installed`、`server_running` 与 `models.image/model3d.configured`。
2. 未安装或未运行时调 `setup`（或直接调生成工具，会自动安装启动）。首次安装需下载约 1.3 GB 前端资源，耗时数分钟，属正常现象；中断后重试会续跑幂等步骤。
3. `models.*.configured=false` 时，提示用户在 MCP 配置的 `env` 中补齐 `IMAGE_*` / `CHAT_*`（3D 需要视觉对话模型），不要自行编造配置。

## 工具速查

| 工具 | 关键参数 | 用途 |
| --- | --- | --- |
| `setup` | `relief?` | 安装并启动本地服务（幂等） |
| `status` | — | 查看安装/运行/模型配置状态 |
| `text_to_image` | `prompt`, `aspect_ratio?`, `size?`, `wait_seconds?` | 文生图 |
| `image_to_image` | `prompt`, `images[1-4]`, `aspect_ratio?`, `size?`, `wait_seconds?` | 图生图（修改/融合/精修参考图） |
| `text_to_3d` | `prompt`, `wait_seconds?` | 文生3D，导出 GLB/STL/DXF/JSON |
| `image_to_3d` | `image`, `prompt?`, `wait_seconds?` | 图生3D，导出 GLB/STL/DXF/JSON |
| `get_task` | `task_id`, `wait_seconds?` | 查询任务状态与结果 |
| `list_tasks` | `limit?` | 最近任务历史 |
| `open_workspace` | `open_browser?` | 返回内嵌浏览器可打开的工作台 URL |

## 核心调用模式：异步任务

生成工具默认立即返回 `{ task_id, status: "running" }`，**必须轮询拿结果**：

1. 提交生成工具（可带 `wait_seconds: 110` 同步等待一轮）。
2. 仍为 `running` 时，循环调 `get_task { task_id, wait_seconds: 110 }`，直到 `succeeded` / `failed` / `interrupted`。图片约 1 分钟；3D 多阶段管线可能 3–10 分钟，耐心轮询，不要中途重复提交。
3. **同一时间只允许一个生成任务**。返回「已有任务正在生成」时，用错误信息里给出的 `task_id` 调 `get_task` 等它完成，再提交新任务。
4. `succeeded` 后向用户交付：`output.url`（浏览器可看）与 `output.local_path`（本地文件）；3D 任务还有 `artifacts`（GLB/STL/DXF/JSON 各自的 URL 与本地路径）和 `metadata`（尺寸、三角面数、工艺限制）。
5. `failed` 时如实转述 `error`（多为模型配置、额度或参数问题），不要编造生成结果，也不要把历史任务输出冒充本次结果。

## 四个生成能力的用法

- **文生图** `text_to_image`：`prompt` 写清材质、宝石、镶嵌结构、风格与背景，例如「一枚祖母绿黄金戒指，四爪镶嵌，白色背景产品摄影图」。`aspect_ratio` 如 `1:1`、`3:4`；`size` 只有 `1K`/`2K`（默认 2K），**没有 4K**。
- **图生图** `image_to_image`：`images` 传本地文件绝对路径或 http(s) URL（1–4 张，MCP 自动上传到本地服务）；`prompt` 写修改要求，例如「把黄色金属改为白色金属，保留款式与宝石」。上一轮结果的 `local_path` 可直接作为下一轮参考图。
- **文生3D** `text_to_3d`：`prompt` **必须包含必要尺寸**（如「戒圈直径 17mm，主石 8mm 圆形明亮式切割，四爪镶，戒臂宽 2.5mm」），否则模型只能猜测比例。
- **图生3D** `image_to_3d`：`image` 传一张参考图；`prompt` 补充尺寸与材质要求。适合线稿/产品图转概念实体。

## 打开页面

调 `open_workspace` 取 `url`（默认 `http://127.0.0.1:4174/workspace/2020`），交给内嵌浏览器打开；需要系统浏览器时传 `open_browser: true`。页面与 MCP 共用同一任务历史，网页端提交的任务也能用 `get_task`/`list_tasks` 查询。

## 边界与纪律

- 3D 输出是**参数化实体概念模型**（图元 + 布尔 + 渲染自评），动物/人像等有机造型只能近似；不是加工级 CAD，不保证封闭可打印。向用户交付时保留这一说明。
- 图片实际像素以模型输出为准，不要把 2K 文件宣称为 4K。
- 密钥只存在于运行实例 `.env`；不要在回复、日志或网页中输出 `IMAGE_API_KEY` 等任何密钥。
- 生成失败/未接入的能力（视频、专用抠图/超分）会明确报错，如实反馈，不要用其他工具的结果顶替。