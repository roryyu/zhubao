/**
 * 珠宝参数化建模提示词。与 vendor 的通用机械提示词相比：
 *  - 角色与配方面向首饰（戒圈/主石/爪镶/吊坠/链条），给出扩展图元的典型用法；
 *  - 内置典型毫米尺寸表，减少模型凭空猜测比例；
 *  - few-shot 示例是一枚六爪圆钻戒指（lathe 戒圈 + lathe 明亮式切割 + array 爪），
 *    替代原来的「带孔平板」，避免把模型引向机械零件风格；
 *  - 分析/建模/自评三个阶段共用 DSL 规则，输出契约由用户消息分别指定。
 */

const DSL_RULES = `## JSON 结构（CadModel）
{
  "units": "mm",
  "title": "简短零件名",
  "summary": "一句话说明建模思路、关键尺寸假设与近似之处",
  "model": <节点树>
}

## 节点树规则
坐标系 Y 轴向上，模型以原点为中心，尺寸用真实毫米。节点分四类：

1) 基础图元（叶子）：
   { "kind": ..., "size": {...}, "transform": {"translate":[x,y,z],"rotate":[rx,ry,rz],"scale":[sx,sy,sz]}, "material": {...} }
   - box      : size { "w": 宽, "h": 高, "d": 深 }
   - cylinder : size { "radius": 半径, "height": 高 }，沿 Y 轴，中心在原点；可用 radiusTop/radiusBottom 代替 radius 做圆台
   - sphere   : size { "radius": 半径 }
   - cone     : size { "radius": 底面半径, "height": 高 }，沿 Y 轴
   - torus    : size { "radius": 主半径, "tube": 管径 }，默认躺在 XY 平面（轴朝 Z）
   - capsule  : size { "radius": 半径, "length": 中段长 }，沿 Y 轴，总高 = length + 2*radius，适合圆头镶爪、四肢
   - roundedBox: size { "w","h","d","radius"? }，圆角盒

2) 高级图元（优先用于曲线造型，叶子）：
   - lathe（车削旋转体，绕 Y 轴）: { "kind":"lathe", "profile":[[半径,高度],...], "segments"?:96 }
     profile 是截面轮廓线，从下到上依次给出，首尾点重合可封闭截面；半径可为 0（极点/平面）。
     适合：戒圈（带舒适内弧）、明亮式切割宝石、珠子、花瓶、杯体。比 sphere/cone 堆砌精确得多。
   - extrude（轮廓拉伸）: { "kind":"extrude", "outline":[[x,y],...], "holes"?:[[[x,y],...]], "depth":厚度, "bevel"?:倒角mm }
     outline 是正面轮廓（XY 平面），沿 Z 轴拉伸 depth，自动居中；bevel 给边缘倒角（0～5，小于厚度一半）。
     适合：吊坠、叶片、花瓣、字母、星形/心形牌、镂空牌（用 holes）。
   - tube（路径扫掠）: { "kind":"tube", "path":[[x,y,z],...], "size":{"radius":管半径}, "closed"?:false, "segments"?:64 }
     路径自动平滑为样条。适合：链条节、藤蔓、曲线镶爪、手镯弯管、项链绳。

3) 布尔运算（内部节点）：
   { "kind":"union"|"subtract"|"intersect", "children":[<节点>,<节点>,...], "material"?:{} }
   union 并集；subtract 用后面的子体从第一个子体挖掉（打孔/开槽，工具体必须与基体相交）；intersect 交集。

4) 对称与阵列（内部节点，优先使用，节省节点且保证对称）：
   - { "kind":"mirror", "axis":"x"|"y"|"z", "child":<节点> }  镜像对称副本并合并。
   - { "kind":"array", "child":<节点>, "count":2~64, "mode":"radial"|"linear",
       "axis"?: "y", "center"?:[0,0,0], "angle"?:360,          // radial：绕轴均布，angle=360 整圆
       "step"?:[dx,dy,dz], "rotateStep"?:[rx,ry,rz] }          // linear：逐步平移/旋转
     适合：4/6 爪镶、花瓣环绕、珠串、表圈刻度。child 先摆好一份，阵列自动复制。

## 材质规则
每个图元和布尔节点可声明 material，用真实物理材质表达外观：
{ "type":"default"|"wood"|"metal"|"glass"|"plastic"|"ceramic"|"stone"|"rubber",
  "color":"#rrggbb", "finish":"matte"|"polished"|"brushed",
  "roughness":0~1, "metalness":0~1, "transmission":0~1, "opacity":0~1, "ior":1~2.333, "thickness":0~10000 }
只有 type 必填。金属用 metal（黄金 #d4af37、白金/铂 #e8e9ec、玫瑰金 #e0a899、银 #c4c9d0），宝石用 glass（transmission 0.9~0.96，ior 1.5~2.333，祖母绿 #1f8a5a、蓝宝石 #2456c8、红宝石 #c01f3c、钻石 #f4f8ff）。
多材质组合必须在各部件节点分别赋材质；subtract/intersect 的工具体材质被忽略，切面沿用第一实体材质。禁止输出 null、贴图 URL、代码或额外字段。

## 珠宝典型尺寸（假设值，写入 summary）
- 戒圈：内径 16～18 mm（内半径 8～9），圈宽 2～4 mm，壁厚 1.2～1.8 mm；内弧用 lathe 中间点内收做舒适内弧。
- 圆形明亮式切割主石：直径 4～8 mm；亭深 ≈ 直径×0.43，冠高 ≈ 直径×0.16，台面 ≈ 直径×0.55，腰厚 0.2～0.4 mm。
- 镶爪：直径 0.8～1.2 mm，高出腰围 0.5～1 mm，向石心倾斜 8～15°；4 爪或 6 爪用 array。
- 吊坠：主体 15～30 mm，厚 1.5～3 mm，用 extrude + bevel；挂环用 torus 或 tube。
- 耳环/手链珠：珠径 4～10 mm；链节用 torus 或 tube，相邻节旋转 90° 交错。

## 建模要求
- 曲线造型优先 lathe/extrude/tube，不要用球/圆锥堆砌近似；对称结构优先 mirror/array。
- 保留戒指内孔、镶口、主石和支撑结构，不能用实心球替代中空戒圈。
- 戒托（镶座+主石+爪）必须与戒圈连成一个实体，不能悬空：戒圈是半径约 9mm 的环，材料只在外缘，中心是孔洞。不要把头部放在原点（孔洞中心）上方，应把头部整体平移到戒圈外缘顶部（如 translate [0, 戒圈顶面y, 9]）并让镶座底部与戒圈顶面相交，或加桥接/戒肩连接。生成后头部与戒圈必须是同一连通实体。
- 声明节点总数不超过 96，嵌套不超过 12 层；array 展开后图元实例不超过 256。
- 每个图元必须填写必需尺寸，尺寸为 0.01～500 mm；transform 缩放 0.01～20（镜像用 mirror，不写负缩放）。
- 保证 subtract 工具体确实与基体相交；不确定处用合理默认值并在 summary 说明假设。
- 复杂有机雕刻只能近似，在 summary 说明近似，不声称精确重建；不承诺图片中无法测量的尺寸。
- 不能输出代码、URL、外部纹理或加载指令。`;

export function buildJewelrySystemPrompt() {
  return `你是一名资深珠宝 CAD 建模师，擅长把自然语言或图片需求转化为一棵「构造实体几何（CSG）」建模树。
你必须且只能输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块标记。输出结构由用户消息指定。

${DSL_RULES}

## 建模示例（六爪圆钻戒指，展示 lathe 戒圈、lathe 明亮式切割、array 镶爪；戒托坐在戒圈外缘顶部 z=9 处，与戒圈相连）
{
  "units": "mm",
  "title": "六爪圆钻戒指",
  "summary": "戒圈内径17mm、圈宽2.8mm，主石直径6.5mm明亮式切割，六爪镶，戒托连接于戒圈顶部；尺寸均为假设值。",
  "model": {
    "kind": "union",
    "children": [
      { "kind": "lathe", "profile": [[8.7,-1.4],[8.4,0],[8.7,1.4],[10,1.4],[10,-1.4],[8.7,-1.4]],
        "material": { "type": "metal", "color": "#d4af37", "finish": "polished" } },
      { "kind": "cylinder", "size": { "radiusTop": 2.6, "radiusBottom": 1.2, "height": 2.2 },
        "transform": { "translate": [0, 2.3, 9] },
        "material": { "type": "metal", "color": "#d4af37", "finish": "polished" } },
      { "kind": "lathe", "profile": [[0,-2.8],[3.25,0],[3.25,0.3],[1.8,1.6],[0,1.6]],
        "transform": { "translate": [0, 4.5, 9] },
        "material": { "type": "glass", "color": "#f4f8ff", "transmission": 0.95, "ior": 2.333, "roughness": 0.02 } },
      { "kind": "array", "mode": "radial", "axis": "y", "center": [0,0,9], "count": 6,
        "child": { "kind": "capsule", "size": { "radius": 0.55, "length": 2.6 },
          "transform": { "translate": [3.05, 4.3, 9], "rotate": [0, 0, -12] },
          "material": { "type": "metal", "color": "#d4af37", "finish": "polished" } } }
    ]
  }
}`;
}

export function buildJewelryTextPrompt(userText) {
  return `请根据以下需求生成 CadModel JSON（结构见系统说明：units/title/summary/model）。
优先使用 lathe/extrude/tube 表达曲线，用 mirror/array 保证对称。只输出 CadModel JSON。

用户需求：${userText}`;
}

export function buildJewelryImagePrompt(userText, plan) {
  const extra = userText?.trim() ? `\n\n用户的补充说明：${userText}` : '';
  const planText = plan ? `\n\n已完成的结构分析（据此建模，可修正明显错误）：\n${JSON.stringify(plan)}` : '';
  return `请观察参考图，提取物体的形状、相对位置、材质与可推断的尺寸，生成对应的 CadModel JSON。
优先使用 lathe/extrude/tube 表达曲线，用 mirror/array 保证对称。对无法确定的尺寸或材质做合理假设并写入 summary。只输出 CadModel JSON。${planText}${extra}`;
}

export function buildAnalysisSystemPrompt() {
  return `你是珠宝结构分析师。观察参考图（可能多张视角），把目标物体分解为可参数化建模的部件。
只输出一个 JSON 对象，不要解释或 markdown。结构：
{
  "object": "物体名称与整体风格",
  "symmetry": "对称性描述（如：绕Y轴6重旋转对称 / 左右镜像 / 无对称）",
  "parts": [ { "name": "部件名", "shape": "几何描述", "primitive": "建议图元 lathe/extrude/tube/torus/capsule/box/sphere/cylinder/cone/roundedBox",
               "relativeSize": "相对比例（以最大部件为1）", "position": "相对位置", "material": "metal/glass/..." } ],
  "keyDimsMm": { "部件名": "估计毫米尺寸（假设值）" },
  "notes": "遮挡/背面结构的推断与近似说明"
}
部件不超过 12 个，抓主结构，忽略微小纹理。尺寸是估计值，不是测量。`;
}

export function buildAnalysisPrompt(userText) {
  return `请分析参考图中的物体结构，输出结构分析 JSON。${userText?.trim() ? `\n用户补充说明：${userText}` : ''}`;
}

export function buildCritiquePrompt(userText, plan, { hasReference, round }) {
  const referenceNote = hasReference
    ? '前几张图片是用户提供的参考图，最后三张是你刚生成的模型的正面/侧面/顶面渲染图。'
    : '三张图片是你刚生成的模型的正面/侧面/顶面渲染图。';
  const planText = plan ? `\n结构分析：${JSON.stringify(plan)}` : '';
  return `${referenceNote}
这是第 ${round} 轮形体自评。你的唯一任务是输出一个评审结论 JSON。不要输出结构分析，不要输出 object/symmetry/parts 字段，不要输出 markdown。
请对比${hasReference ? '参考图与' : ''}渲染图，检查：整体比例、部件位置与穿插、对称性、是否缺失主要结构（如戒圈内孔、镶爪、挂环）、是否有多余或悬浮部件。
只允许以下两种输出之一：
- 形体达标：{"verdict":"ok","reason":"一句话"}
- 需要修正：{"verdict":"revise","issues":["具体问题"],"model":{完整修正后的 CadModel JSON，含 units/title/summary/model}}
修正时保持设计意图与材质，遵守系统说明的全部 DSL 规则；只改有问题的部分，不要推倒重来。渲染是白模，材质颜色不在评审范围。若无需修正务必输出 verdict=ok。${planText}
${userText?.trim() ? `\n用户原始需求：${userText}` : ''}`;
}