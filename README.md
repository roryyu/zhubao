# 创觉珠宝 AI 本地版

这是一个在本机运行的珠宝 AI 设计实验项目。项目保留创觉珠宝 AI 网站的公开界面与资源，并新增本地后端，用于首饰效果图生成、参考图修改、浮雕文件生成和参数化 3D 草模试验。

前端来自原站公开部署的 Vue 构建包，本地服务按已观察到的接口重新实现。原站私有后端、模型权重和账户业务没有恢复。项目适合设计概念探索、界面复刻研究与模型接口试验。

**当前 3D 功能生成参数化实体概念模型，动物、人像和复杂首饰的有机造型仍为近似。** 已生成 GLB 文件代表调用和导出流程可运行，不代表模型达到设计或加工要求。

## 打开与启动

打开 [本地工作台](http://127.0.0.1:4174/workspace/2020)。

服务停止后，在终端运行：

```bash
cd /Users/roryyu/Downloads/code/mycode/codex/sites/cjzbai-local
npm start
```

需要 Node.js 24 或更新版本。当前机器的 JavaScript 依赖、Python 环境和浮雕深度模型均已准备好。默认仅监听本机 `127.0.0.1:4174`，按 `Ctrl+C` 停止。

首次安装或迁移到其他机器时，在项目目录运行：

```bash
npm install
npm run setup:geometry
npm run build
```

浮雕环境需要 Python 3.12+。`setup:geometry` 会创建 Python 环境、安装依赖，并下载约 100 MB 的深度模型。模型和运行数据保存在 `data/`，迁移时需要保留或重新准备。

启动前，按 [.env.example](.env.example) 在本机创建 `.env`，填写图片与对话服务配置。已有 `.env` 时保留原文件。详细步骤见 [模型配置.md](模型配置.md)。模板中的 `vision-script` 方式依赖工作区根目录的 `vision.js`；独立使用本项目时，应配置自己的模型接口。

## MCP 服务（Codex / Workbuddy 等）

`mcp/server.mjs` 提供零依赖的 stdio MCP 服务：MCP 客户端可从 GitHub 克隆本工程、自动安装构建并启动本地服务，然后调用文生图、图生图、文生3D、图生3D，或取得可供内嵌浏览器打开的工作台 URL。首选**客户端模型模式**：MCP 返回提示词，由 Codex/Workbuddy 自己的大模型生成（建模 JSON/图片）再回传本地构建导出，3D 带多轮自评修正循环，不依赖 `.env` 里的特定模型；也保留服务端模型模式作备选。前端大文件资源通过 GitHub Release（`frontend-assets-v1`）分发，首次安装自动下载。

### 让 Codex / Workbuddy 安装并使用

1. 克隆仓库到任意目录（这一步只是拿到 MCP 入口脚本，运行实例由 MCP 自动安装）：

   ```bash
   git clone https://github.com/roryyu/zhubao.git
   ```

2. 在 MCP 客户端注册服务，命令指向克隆目录里的 `mcp/server.mjs`，用 `env` 注入你自己的模型接口（键名与 [.env.example](.env.example) 一致，详见 [模型配置.md](模型配置.md)）：

   **Codex**（`~/.codex/config.toml`）：

   ```toml
   [mcp_servers.cjzbai]
   command = "node"   # 建议写 node 绝对路径，需 Node.js ≥ 24
   args = ["/absolute/path/zhubao/mcp/server.mjs"]
   startup_timeout_sec = 30
   tool_timeout_sec = 1800   # 首次安装要下载约 1.3 GB 前端资源

   [mcp_servers.cjzbai.env]
   IMAGE_BASE_URL = "https://your-image-endpoint/v1"
   IMAGE_API_KEY = "sk-..."
   IMAGE_MODEL = "your-image-model"
   IMAGE_API_STYLE = "auto"   # auto / images / chat / dashscope
   CHAT_BASE_URL = "https://your-chat-endpoint/v1"
   CHAT_API_KEY = "sk-..."
   CHAT_MODEL = "your-vision-chat-model"   # 3D 建模需视觉对话模型
   CHAT_VISION = "true"
   ```

   **Workbuddy / 其他 MCP 客户端**（JSON 配置）：

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
           "CHAT_BASE_URL": "https://your-chat-endpoint/v1",
           "CHAT_API_KEY": "sk-...",
           "CHAT_MODEL": "your-vision-chat-model",
           "CHAT_VISION": "true"
         }
       }
     }
   }
   ```

3. 在对话里让 Agent 调用 `setup`（或直接提生成需求）：首次会自动把运行实例安装到 `~/.cjzbai-mcp/zhubao`（克隆、下载前端资源、安装构建、写 `.env`、启动服务，需数分钟），之后秒级就绪。已有本地 checkout 时，可设 `CJZBAI_PROJECT_DIR` 指向它，复用现有 `.env` 与历史数据。
4. 可选：把 [mcp/SKILL.md](mcp/SKILL.md) 安装为 Agent Skill（如 Codex 的 `~/.codex/skills/cjzbai/SKILL.md`），让 Agent 掌握异步任务轮询、参考图上传与结果交付的调用规范。

环境变量、工具参数与排障见 [mcp/README.md](mcp/README.md)。

## 技术组成

| 部分 | 实现 |
| --- | --- |
| 页面 | 原站 Vue 生产构建、CSS、字体与媒体资源；通过本地构建脚本适配 |
| 本地服务 | Node.js，提供静态资源、上传、任务历史、模型调用和结果下载 |
| 图片与对话 | 支持工作区 `vision.js` 或独立接口；千问图片使用 DashScope 原生协议 |
| 浮雕 | Python、ONNX Runtime 和 Depth Anything V2 Small，推理在本机 CPU 上执行 |
| 参数化 3D | Qwen 生成扩展建模 JSON（车削/拉伸/扫掠/对称阵列）；Three.js 和布尔几何引擎计算网格，渲染自评修正 |
| 数据保存 | 本地 JSON 文件和磁盘目录，无外部数据库依赖 |

## 已还原的范围

原站：[创觉珠宝 AI](https://www.cjzbai.com/)。公开数据与资源主要采集于 2026 年 11 月 8 日，登录后界面及本地交互于 11 月 9 日继续核验。

本地版沿用原站公开发布的 Vue 生产构建、样式、字体和静态资源。保留首页、5 类 20 个工具、7 个顶栏入口、参数表单、上传预览、画廊、教程、会员页面和账户页面的界面。

### 奢侈品黑金主题

本地版品牌已重命名为「无觉」：界面中的「创觉」文案与「创」字标（导航 logo、启动页字标、头像、favicon、画布生成字标）在构建时统一替换为「无觉」/「无」（`src/brand-mark.svg`、`src/favicon.ico`）；`captured/` 与 `evidence/` 保留原站字节与历史记录，不做改写。「创作/创建」等非品牌词不受影响。

本地版在原站暗色界面上叠加了一层「奢侈品黑金」主题（`src/luxury-theme.css`，构建时注入 `dist/local/luxury-theme.css`）。设计母题取自珠宝本身：首饰陈列柜的丝绒暖黑、金箔切边细线、铭牌式雕刻衬线标题（Didot/宋体族，本机字体无需联网）、贵金属拉丝渐变主按钮。原站品牌金 `#D4AF37` 保留为唯一强调色，原界面中的蓝/紫渐变（按钮、滑杆、加载环、玻璃卡描边等）统一归一到香槟金家族，冷灰文字与纯黑表面统一为暖象牙与暖黑；Element Plus 全套变量转入暗金，弹层/输入/分页等组件同步。主题只做样式覆盖，不改原站构建产物与业务逻辑；正文对比度保持 ≥4.5:1。

| 内容 | 本地范围 |
| --- | --- |
| 智能工坊 | 浮雕、图转 3D、图像创作、电商设计、视频和实用工具，共 20 个入口 |
| 公开作品 | 87 条公开作品记录，可分页、筛选、预览；配套公开图片、视频和模型已保存 |
| 教程 | 18 篇教程及其公开媒体，支持详情页和本地视频读取 |
| AI 对话 | 9 个公开场景预设，支持选择预设和创建本地对话草稿 |
| 共享参数 | 取得 83 条公开作品的共享表单参数，可恢复已取得的参数 |
| 价格与选项 | 来自原站无需登录的公开只读接口，固定为采集时的快照 |
| 账户资料 | 演示用户 `100001`，演示算力为 50；不代表真实账户余额 |

公开资源约 1.39 GB，主要是教程视频、作品视频和 3D 模型。原站署名和构建包中的第三方许可证说明均予保留。

## 实际设计与模型配置

本地设计后端支持工作区 `vision.js` 和独立模型接口。当前使用你配置的独立千问图片、对话服务；图片接口按 DashScope 原生协议提交，3D 建模默认沿用独立对话接口。Key 只保留在本机 `.env`，不填入网页。

已在网页实测：输入需求生成一枚祖母绿黄金戒指；上传该图作为参考，将黄色金属修改为白色金属；预览结果、查看任务历史并下载。两次成功任务的记录、文件哈希和验证范围见 `evidence/real-design-verification.json`。失败的协议探测任务也保留，未冒充成功。

| 功能 | 当前状态 |
| --- | --- |
| 文案生图 | 已通过网页调用真实模型，取得 2048 × 2048 新图片 |
| 产品精修、参考图修改 | 已通过网页上传、真实模型生成与下载验证 |
| 一键设计、多图融合、线稿/写实、多视图、自由创作、灵感创作、详情页/佩戴 | 已接入相应参数和图片输入，使用同一图片模型；尚未逐项做付费效果验收 |
| AI 对话 | 支持工作区 `vision.js` 或独立 OpenAI 兼容接口；实际测试状态见验证记录 |
| 图片转浮雕 | 本地 Depth Anything V2 Small 计算相对深度，已实测生成 16 位 TIF/PNG、浮点 EXR、封闭 STL、GLB |
| 带线 VS 浮雕 | 已实测生成三维浮雕网格及沿表面高度分布的原图线条，导出标准 DXF、STL、GLB、TIF |
| 文生 / 图生 3D 模型 | 复用并扩展 `create-3d-things` 参数化布尔几何引擎；图片先结构分析，建模后三视角渲染自评修正；已生成 GLB、STL、DXF 和 JSON，可旋转预览及下载 |
| 图像转立体化 | 已用真实图片模型将黑白首饰线稿转换为立体渲染效果图；输出是图片 |
| 视频、专用抠图/超分工具 | 尚未接入专用后端，提交会明确报错 |

四项新增功能的真实任务、文件哈希、网格检查和截图见 [验收记录](evidence/four-feature-verification.json)。记录验证了模型调用、计算、文件导出与读取流程，未证明造型质量达到专业设计要求。

### 3D 模型的能力边界

当前流程为“文字或参考图 →（图片模式）Qwen 结构化视觉分析 → Qwen 生成扩展建模 JSON → 图元与布尔运算 → 三视角渲染 → 同一视觉模型自评修正 → 网格导出”。图元在原有方块、球体、圆柱、圆锥、圆环之外，新增车削旋转体（lathe）、轮廓拉伸（extrude）、路径扫掠（tube）、胶囊（capsule）和圆角盒（roundedBox），并提供镜像（mirror）与阵列（array）对称结构。戒圈、明亮式切割宝石、吊坠轮廓和爪镶等曲线/对称造型的表达力明显优于纯图元堆砌。

动物、人像、雕塑以及复杂珠宝花纹的有机曲面仍只能近似。自评修正能改善比例、位置和缺失结构，但不能补回 DSL 无法表达的形体，也不保证设计级精度。页面已将此模式标为“参数化实体建模（概念模型）”。

未知尺寸和背面结构由模型推断。参数化网格不保证封闭，不能直接用于打印；石位、壁厚、公差、铸造和加工可行性也未验证。建模 JSON 可下载后修改，当前页面未提供完整 CAD 编辑器。

代码中保留了 Tripo 适配器及模拟测试，但当前没有启用，也没有完成真实服务验收。本机没有部署通用神经 3D 重建模型。当前图片与对话接口的连通性不能证明专用 3D 服务可用。

### 浮雕与图片的能力边界

浮雕是带底板的相对高度场。浅、中、高起伏分别为 1/3/6 mm，底板厚 0.6 mm；画布长边由用户设置。单图推断的深度不是实物测量值，也不能还原完整圆雕。

VSM、VS3D、JDP 等专有格式未恢复，界面使用实际支持的标准格式。STL 和 DXF 使用毫米，GLB 使用米；TIF/PNG 保存 16 位高度，EXR 的 Z 通道保存毫米高度。

当前 Qwen 图片服务支持最高约 2K 等效像素。选择原界面的 4K 会明确拒绝，不能把 2K 文件标成 4K。1K、2K 和比例会转换为像素请求，输出尺寸以实际文件为准。多视图属于模型生成的概念图，不保证多视角几何一致，也不代表可直接开模的 CAD。

网页标注的算力是演示值，原站价格仅供参考。真实费用由你配置的模型服务商收取。本地任务保存在 `data/tasks.json`，图片保存在 `data/generated/`；重启后可以读取历史。对话当前保存在内存，重启会清空。

## 服务端能力边界

原站模型权重、私有推理流程和业务服务端代码没有从网页中取得。本地后端是按公开前端接口重新实现的设计调用层，不等同于恢复原站整套服务端。

支付、短信、真实账户管理和团队协作服务尚未接入。账户页使用演示数据；原站私有历史未导出，本地新设计有独立历史。你的原站 Token、Cookie、手机号和验证码没有复制到本地项目。

公开作品中的已有图片、视频和模型是采集到的真实公开资源。它们与本地新生成结果是两回事。共享参数保留的是公开表单参数；任务的私有会话、账号资料和服务端输出元数据没有导出。

## 已知缺失

- 两个原站公开附件在采集时返回 HTTP 404，其中一个为 PNG，另一个为 VSM。图片位置使用缺图提示；缺失工程文件保持不可用。
- 4 条公开作品的共享参数接口未返回可用数据。详情见 `evidence/shared-params-manifest.json`，本地不会编造这些参数。
- 生产构建已经压缩。`captured/` 是公开部署包，`evidence/readable/` 是自动格式化后的副本，两者均不等同于原项目的 Vue 单文件源码、构建配置或 Git 历史。
- 时钟、任务名称中的日期、账户资料和运行期状态会与原站不同。未穷举所有鼠标操作、元件参数、浏览器和设备。

## 验证

```bash
# 校验原始资源与本地文件的 SHA-256
npm run verify

# 服务启动后，同时验证上传回读、视频 Range 和未接入服务的拒绝反馈
npm run verify -- --url http://127.0.0.1:4174

# 本地模拟接口测试，不调用付费模型
npm run test:models

# 参数化几何导出和模型回复校验，不调用付费模型
npm run test:cad

# 浮雕高度、尺寸、封闭性及文件格式检查
npm run test:relief
```

REA 已执行 20 个工具和 7 个顶栏入口的切换检查，共 79 个场景步骤，均完成。浏览器中另行检查了图片选择与预览、未接入生成服务的提示、对话预设、对话服务拒绝反馈及教程点击跳转。一个教程视频已读到完整媒体元数据，时长为 35.619 秒。

资源、上传、分段读取和未接入能力的拒绝检查结果保存在 `evidence/verification.json`。`npm run test:models` 使用本地模拟接口验证协议与失败处理，不调用付费模型。`npm run test:relief` 检查高度、单位、封闭网格和格式；`npm run test:cad` 检查真实几何导出、非法结构拒绝和修正次数上限。真实设计证据另见 `evidence/real-design-verification.json` 和 `evidence/four-feature-verification.json`；不代表其他工具或支付能力通过。

教程列表会短暂显示“加载教程中”的遮罩。自动操作需要等待遮罩消失后再点击卡片；直接打开详情 URL 也可使用。

## 文件与修改位置

| 路径 | 用途 |
| --- | --- |
| `captured/` | 公开资源的原始字节和来源快照 |
| `dist/` | 实际运行的站点资源 |
| `server.mjs` | 本地静态服务、上传、视频分段读取及接口入口 |
| `server/fixtures.mjs` | 读取接口适配和本地演示状态 |
| `server/image-service.mjs` | 模型出图、参考图编辑、任务与结果保存 |
| `server/geometry-service.mjs` | 浮雕与 3D 任务路由、尺寸校验及标准文件交付 |
| `server/relief_worker.py` | 本地神经深度、高度场、封闭网格和带线 DXF 导出 |
| `server/cad-provider.mjs` | 模型建模 JSON 校验、参数化几何和 GLB/STL/DXF 导出 |
| `vendor/create-3d-things/` | 用户项目的必要建模代码及来源清单 |
| `server/tripo-service.mjs` | 未启用的专用 3D 服务适配器，仅通过模拟测试 |
| `server/chat-service.mjs` | 模型对话、上下文与网页 SSE 适配 |
| `.env.example` | 模型服务配置模板 |
| `mcp/server.mjs` | 零依赖 MCP 服务：自举安装启动 + 文生图/图生图/文生3D/图生3D 工具 |
| `mcp/SKILL.md` | Agent Skill：教 Codex/Workbuddy 等如何调用本 MCP |
| `server/public-data.json` | 工具目录、参数选项、价格和页面配置 |
| `server/public-content.json` | 公开教程、作品和对话预设 |
| `server/public-tasks.json` | 已取得的公开共享参数 |
| `data/uploads/` | 本地上传文件，已加入忽略规则 |
| `scripts/build-local.mjs` | 将原始资源组装为本地版，并记录适配差异 |
| `src/luxury-theme.css` | 奢侈品黑金主题覆盖层，构建时注入页面 |
| `evidence/local-patches.json` | 对入口 HTML 和 JavaScript 的适配记录 |
| `evidence/rea-analysis.json` | REA 静态分析及浏览器取证记录 |
| `evidence/调查结论.md` | 证据、判断范围和剩余边界 |

修改服务入口后需重启 `npm start`。修改前端适配脚本后运行 `npm run build`。采集脚本保留用于追溯，普通启动不需要运行；重新采集会覆盖快照，不应当作无需核验的自动升级。

本地版移除了外部统计脚本。浏览器仅连接本地服务，由 Node 服务端和 `vision.js` 调用你配置的模型；不复用原站登录凭据。

## 来源与使用范围

本项目保留原站署名与构建包中的第三方许可证说明。

`create-3d-things` 的代码来自用户指定的本地项目，仅复制建模所需文件，未复制凭据。该项目在检查时未发现许可证文件；本地复用记录和文件哈希见 [来源说明](vendor/create-3d-things/PROVENANCE.md)。
