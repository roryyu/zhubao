---
name: cjzbai-jewelry
description: 通过 cjzbai MCP 服务生成珠宝设计图与 3D 概念模型（文生图、图生图、文生3D、图生3D），并打开本地工作台页面。当用户要求设计首饰/戒指/吊坠/手镯效果图、上传参考图修改材质或款式、生成珠宝 3D 模型（GLB/STL/DXF）、或打开无觉珠宝工作台时使用。
---

# 无觉珠宝 AI · MCP 调用技能

配合 `cjzbai` MCP 服务使用（脚本为本仓库 `mcp/server.mjs`，注册见 `mcp/README.md`）。工具名可能带客户端前缀（如 `mcp__cjzbai__prepare_3d`），按语义匹配。

## 职责边界

**这个 MCP 只提供工具和本地算力，不调用任何大模型。** 图片和 3D 建模结果必须由你（调用方 Agent）用自己的模型生成：

- 它返回提示词、参考图 URL、任务 ID；
- 你生成图片或建模 JSON，用 `submit_*` 回传；
- 它做本地几何构建、校验、渲染导出、保存与登记，并返回可展示的页面 URL。

不需要也不应该向它传任何模型地址、模型名或 API Key。工程自带的网页工作台有自己的 `.env`，与本 MCP 无关。

## 首次使用

1. `status` 查看安装/运行状态；未安装或未运行时调 `setup`（或直接调生成工具，自动安装启动）。首次安装需 `npm ci` 与构建前端，一两分钟属正常；构建骨架随仓库分发，不需要额外下载。
2. 不需要配置任何模型密钥：图片与建模都由你自己生成。

## 3D 调用流程（prepare_3d → 你的模型 → submit_3d 循环）

1. `prepare_3d`：文生传 `prompt`（**必须含必要尺寸**，如戒圈直径 17mm、主石 8mm）；图生传 `image`（本地路径/URL，自动先返回结构分析提示词）。返回 `task_id` + `stage` + `system_prompt` + `user_prompt` + `reference_images`。
2. 你按提示词输出 JSON（只输出 JSON，遵守其中的 DSL 规则）：
   - `stage=analysis` → 结构分析 JSON（object/symmetry/parts/keyDimsMm）；
   - `stage=build` → CadModel JSON（units/title/summary/model，优先 lathe/extrude/tube + mirror/array）。
3. `submit_3d { task_id, output }`，按返回继续：
   - `stage=build, correction=true`：建模校验失败，按 `user_prompt` 在同一对话中修正后重发（最多 2 次）；
   - `stage=critique` + `render_images`：**查看三视角渲染图**，输出评审 JSON：达标 `{"verdict":"ok","reason":"..."}`；需修正 `{"verdict":"revise","issues":[...],"model":{完整修正 CadModel}}`，再 `submit_3d`；
   - `status=succeeded`：交付 `artifacts`（GLB/STL/DXF/JSON 的 URL 与本地路径）+ `metadata`（尺寸/面数/限制），并用 `view_url` 在内嵌浏览器打开 3D 预览页。
4. 无 Python 渲染环境时自评自动跳过，直接完成；`refine_rounds: 0` 可主动跳过。

## 图片调用流程（prepare_image → 你的图像模型 → submit_image）

1. `prepare_image { prompt, images?, aspect_ratio?, size? }` → 返回合成好的出图提示词与参考图 URL。
2. 用你自己的图像生成能力出图；若你当前没有图像生成能力，坦白告知用户并给出提示词，由用户自己出图后再用 `submit_image` 回传（也可传入本地已有图片）。
3. `submit_image { task_id, image }`：image 为生成图的本地路径、URL 或 data URL → 服务端校验保存、登记历史，返回 `output` 与 `view_url`（内嵌浏览器打开图片页）。
4. 上一轮结果的本地路径可直接作为下一轮 `images` 参考图（迭代修改）。

## 工具速查

| 工具 | 用途 |
| --- | --- |
| `setup` / `status` | 安装启动（幂等）/ 状态查看 |
| `prepare_3d` / `submit_3d` | 3D 提示词往返（分析→建模→自评循环） |
| `prepare_image` / `submit_image` | 图片提示词往返 |
| `get_task` / `list_tasks` | 任务查询 / 历史（含网页端任务） |
| `open_workspace` | 返回内嵌浏览器可打开的工作台 URL |

## 纪律与边界

- 同一时间只允许一个生成任务；忙时按错误信息里的 `task_id` 用 `get_task` 等待，不要重复提交。Agent 会话 30 分钟无回传会超时作废。
- 图片最高 2K，没有 4K；实际像素以输出文件为准。
- 3D 是参数化实体**概念模型**，有机造型只能近似，非加工级 CAD、不保证封闭可打印；交付时保留该说明。
- 失败如实转述 `error`；不得编造生成结果，不得把历史输出冒充本次结果。
- 不传递、不索要、不输出任何模型密钥；本 MCP 不需要密钥。