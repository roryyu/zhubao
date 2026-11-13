import { z } from 'zod';
import * as THREE from 'three';
import { cadMaterialSchema } from '../../vendor/create-3d-things/schema.ts';

/**
 * 扩展 CAD DSL —— 在 vendor/create-3d-things 的五图元 CSG 之上增加：
 *  - 图元：lathe（车削旋转体）、extrude（轮廓拉伸）、tube（路径扫掠）、
 *          capsule（胶囊）、roundedBox（圆角盒），全部由 three 原生几何实现。
 *  - 结构节点：mirror（镜像对称）、array（径向/线性阵列），在 JSON 层展开为
 *    union + 变换副本，渲染器只需处理基础图元与布尔运算。
 * vendor 目录保持原样；本模块是它的超集，旧模型无需修改即可解析。
 */

const MAX_DECLARED_NODES = 96;
const MAX_DECLARED_DEPTH = 12;
const MAX_EXPANDED_INSTANCES = 256;
const MAX_EXPANDED_NODES = 640;

const vec2Schema = z.tuple([z.number(), z.number()]);
const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const transformSchema = z.object({
  translate: vec3Schema.optional(),
  rotate: vec3Schema.optional(),
  scale: vec3Schema.optional(),
});

const primitiveSchema = z.object({
  kind: z.enum(['box', 'cylinder', 'sphere', 'cone', 'torus', 'lathe', 'extrude', 'tube', 'capsule', 'roundedBox']),
  size: z.record(z.string(), z.number()).optional(),
  profile: z.array(vec2Schema).optional(),
  outline: z.array(vec2Schema).optional(),
  holes: z.array(z.array(vec2Schema)).optional(),
  path: z.array(vec3Schema).optional(),
  depth: z.number().optional(),
  bevel: z.number().optional(),
  closed: z.boolean().optional(),
  segments: z.number().int().optional(),
  transform: transformSchema.optional(),
  color: z.string().optional(),
  material: cadMaterialSchema.optional(),
});

const booleanSchema = z.object({
  kind: z.enum(['union', 'subtract', 'intersect']),
  children: z.lazy(() => z.array(nodeSchema)).refine(arr => arr.length >= 2, { message: 'children 至少需要 2 个节点' }),
  color: z.string().optional(),
  material: cadMaterialSchema.optional(),
});

const mirrorSchema = z.object({
  kind: z.literal('mirror'),
  axis: z.enum(['x', 'y', 'z']),
  child: z.lazy(() => nodeSchema),
  color: z.string().optional(),
  material: cadMaterialSchema.optional(),
});

const arraySchema = z.object({
  kind: z.literal('array'),
  child: z.lazy(() => nodeSchema),
  count: z.number().int().min(2).max(64),
  mode: z.enum(['radial', 'linear']).optional(),
  axis: z.enum(['x', 'y', 'z']).optional(),
  center: vec3Schema.optional(),
  angle: z.number().optional(),
  step: vec3Schema.optional(),
  rotateStep: vec3Schema.optional(),
  color: z.string().optional(),
  material: cadMaterialSchema.optional(),
});

const nodeSchema = z.union([primitiveSchema, booleanSchema, mirrorSchema, arraySchema]);

export const extendedCadModelSchema = z.preprocess((value, ctx) => {
  if (!value || typeof value !== 'object' || !('model' in value)) return value;
  const stack = [{ node: value.model, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > MAX_DECLARED_NODES || depth > MAX_DECLARED_DEPTH) {
      ctx.addIssue({ code: 'custom', message: `模型最多包含 ${MAX_DECLARED_NODES} 个声明节点、${MAX_DECLARED_DEPTH} 层嵌套，请用 mirror/array 精简结构` });
      return z.NEVER;
    }
    if (node && typeof node === 'object') {
      if (Array.isArray(node.children)) {
        if (node.children.length > 64) { ctx.addIssue({ code: 'custom', message: '子节点数量过多，请简化模型' }); return z.NEVER; }
        node.children.forEach(child => stack.push({ node: child, depth: depth + 1 }));
      }
      if (node.child) stack.push({ node: node.child, depth: depth + 1 });
    }
  }
  return value;
}, z.object({
  units: z.string().default('mm'),
  title: z.string().optional(),
  summary: z.string().optional(),
  model: nodeSchema,
}));

const SIZE_RULES = {
  box: { required: ['w', 'h', 'd'], allowed: ['w', 'h', 'd'] },
  cylinder: { required: ['radius', 'height'], allowed: ['radius', 'radiusTop', 'radiusBottom', 'height'] },
  sphere: { required: ['radius'], allowed: ['radius'] },
  cone: { required: ['radius', 'height'], allowed: ['radius', 'height'] },
  torus: { required: ['radius', 'tube'], allowed: ['radius', 'tube'] },
  capsule: { required: ['radius', 'length'], allowed: ['radius', 'length'] },
  roundedBox: { required: ['w', 'h', 'd'], allowed: ['w', 'h', 'd', 'radius'] },
};

function finiteIn(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function checkTransform(t) {
  if (t?.translate?.some(n => !Number.isFinite(n) || Math.abs(n) > 500)) throw new Error('CAD 平移超出 ±500 mm 本地范围');
  if (t?.rotate?.some(n => !Number.isFinite(n) || Math.abs(n) > 3600)) throw new Error('CAD 旋转角度超出本地范围');
  if (t?.scale?.some(n => !Number.isFinite(n) || n < 0.01 || n > 20)) throw new Error('CAD 缩放须为 0.01～20（镜像请用 mirror 节点，不要写负缩放）');
}

function checkPrimitive(node) {
  const kind = node.kind;
  if (SIZE_RULES[kind]) {
    const rule = SIZE_RULES[kind];
    const size = node.size || {};
    for (const key of rule.required) {
      if (size[key] == null && !(kind === 'cylinder' && key === 'radius' && size.radiusTop != null && size.radiusBottom != null)) {
        throw new Error(`CAD ${kind} 缺少尺寸 ${key}`);
      }
    }
    for (const [key, value] of Object.entries(size)) {
      if (!rule.allowed.includes(key) || !finiteIn(value, 0.01, 500)) throw new Error(`CAD ${kind} 尺寸 ${key} 须为 0.01～500 mm，且参数名称必须匹配图元`);
    }
    if (kind === 'roundedBox' && size.radius != null && size.radius > Math.min(size.w, size.h, size.d) / 2) {
      throw new Error('CAD roundedBox 圆角半径不能超过最短边的一半');
    }
    return;
  }
  if (kind === 'lathe') {
    const profile = node.profile;
    if (!Array.isArray(profile) || profile.length < 2 || profile.length > 64) throw new Error('CAD lathe 需要 2～64 个 [半径,高度] 轮廓点');
    for (const point of profile) {
      if (!finiteIn(point[0], 0, 500) || !finiteIn(point[1], -500, 500)) throw new Error('CAD lathe 轮廓点须为半径 0～500、高度 ±500 mm');
    }
    if (node.segments != null && (!Number.isInteger(node.segments) || !finiteIn(node.segments, 8, 128))) throw new Error('CAD lathe segments 须为 8～128 的整数');
    return;
  }
  if (kind === 'extrude') {
    const outline = node.outline;
    if (!Array.isArray(outline) || outline.length < 3 || outline.length > 64) throw new Error('CAD extrude 需要 3～64 个 [x,y] 正面轮廓点');
    for (const point of outline) {
      if (!finiteIn(point[0], -500, 500) || !finiteIn(point[1], -500, 500)) throw new Error('CAD extrude 轮廓点超出 ±500 mm');
    }
    if (node.holes != null) {
      if (!Array.isArray(node.holes) || node.holes.length > 8) throw new Error('CAD extrude 最多 8 个孔轮廓');
      for (const hole of node.holes) {
        if (!Array.isArray(hole) || hole.length < 3 || hole.length > 32) throw new Error('CAD extrude 每个孔需要 3～32 个轮廓点');
        for (const point of hole) if (!finiteIn(point[0], -500, 500) || !finiteIn(point[1], -500, 500)) throw new Error('CAD extrude 孔轮廓点超出 ±500 mm');
      }
    }
    if (!finiteIn(node.depth, 0.01, 500)) throw new Error('CAD extrude depth 须为 0.01～500 mm');
    if (node.bevel != null) {
      if (!finiteIn(node.bevel, 0, 5)) throw new Error('CAD extrude bevel 须为 0～5 mm');
      if (node.bevel >= node.depth / 2) throw new Error('CAD extrude bevel 必须小于厚度的一半');
    }
    return;
  }
  if (kind === 'tube') {
    const path = node.path;
    if (!Array.isArray(path) || path.length < 2 || path.length > 32) throw new Error('CAD tube 需要 2～32 个 [x,y,z] 路径点');
    for (const point of path) {
      if (point.some(n => !finiteIn(n, -500, 500))) throw new Error('CAD tube 路径点超出 ±500 mm');
    }
    if (!finiteIn(node.size?.radius, 0.05, 50)) throw new Error('CAD tube 需要 size.radius 0.05～50 mm');
    if (node.segments != null && (!Number.isInteger(node.segments) || !finiteIn(node.segments, 8, 256))) throw new Error('CAD tube segments 须为 8～256 的整数');
    return;
  }
  throw new Error(`不支持的几何类型 ${kind}`);
}

/** 校验声明模型（展开前）。mirror/array 的副本变换在展开时生成，不走这里。 */
export function validateDeclaredModel(model) {
  const stack = [model.model];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    count++;
    if (node.color && !/^#[\da-f]{6}$/i.test(node.color)) throw new Error('CAD 模型颜色格式无效');
    checkTransform(node.transform);
    if (node.children) { stack.push(...node.children); continue; }
    if (node.child) {
      if (node.kind === 'array') {
        if (node.angle != null && !finiteIn(node.angle, 1, 360)) throw new Error('CAD array angle 须为 1～360 度');
        if (node.center?.some(n => !finiteIn(n, -500, 500))) throw new Error('CAD array center 超出 ±500 mm');
        if (node.step?.some(n => !finiteIn(n, -500, 500))) throw new Error('CAD array step 超出 ±500 mm');
        if (node.rotateStep?.some(n => !finiteIn(n, -3600, 3600))) throw new Error('CAD array rotateStep 超出本地范围');
        if ((node.mode || 'radial') === 'linear' && !node.step && !node.rotateStep) throw new Error('CAD linear array 需要 step 或 rotateStep');
      }
      stack.push(node.child);
      continue;
    }
    checkPrimitive(node);
  }
  return count;
}

function nodeMatrix(t) {
  const rotation = new THREE.Euler(...(t?.rotate ?? [0, 0, 0]).map(THREE.MathUtils.degToRad), 'XYZ');
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(t?.translate ?? [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(...(t?.scale ?? [1, 1, 1])),
  );
}

function matrixToTransform(matrix) {
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const round = n => Math.abs(n) < 1e-9 ? 0 : Number(n.toFixed(6));
  const transform = {};
  if (position.lengthSq() > 0) transform.translate = position.toArray().map(round);
  if (Math.abs(euler.x) + Math.abs(euler.y) + Math.abs(euler.z) > 0) transform.rotate = [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg).map(round);
  if (scale.toArray().some(n => Math.abs(n - 1) > 1e-9)) transform.scale = scale.toArray().map(round);
  return transform;
}

/** 把外部变换推进子树：CSG 对仿射变换等变，因此可以下推到每个叶子。 */
function pushTransform(node, matrix) {
  if (node.children) return { ...node, children: node.children.map(child => pushTransform(child, matrix)) };
  if (node.child) return { ...node, child: pushTransform(node.child, matrix) };
  const composed = matrix.clone().multiply(nodeMatrix(node.transform));
  const next = { ...node, transform: matrixToTransform(composed) };
  if (!next.transform.translate && !next.transform.rotate && !next.transform.scale) delete next.transform;
  return next;
}

function axisVector(axis) {
  return new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
}

function radialMatrix(axis, center, degrees) {
  const c = new THREE.Vector3(...(center ?? [0, 0, 0]));
  const rotation = new THREE.Matrix4().makeRotationAxis(axisVector(axis), THREE.MathUtils.degToRad(degrees));
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(rotation).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}

function countLeaves(node) {
  let leaves = 0;
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.children) stack.push(...current.children);
    else leaves++;
  }
  return leaves;
}

function expandNode(node, budget) {
  if (node.kind === 'mirror') {
    const child = expandNode(node.child, budget);
    budget.instances += countLeaves(child);
    if (budget.instances > MAX_EXPANDED_INSTANCES) throw new Error(`CAD 展开后图元实例超过 ${MAX_EXPANDED_INSTANCES} 个，请减少 array 数量或简化结构`);
    const mirror = new THREE.Matrix4().makeScale(node.axis === 'x' ? -1 : 1, node.axis === 'y' ? -1 : 1, node.axis === 'z' ? -1 : 1);
    const union = { kind: 'union', children: [child, pushTransform(child, mirror)] };
    if (node.material) union.material = node.material;
    if (node.color) union.color = node.color;
    return union;
  }
  if (node.kind === 'array') {
    const child = expandNode(node.child, budget);
    const count = node.count;
    budget.instances += countLeaves(child) * (count - 1);
    if (budget.instances > MAX_EXPANDED_INSTANCES) throw new Error(`CAD 展开后图元实例超过 ${MAX_EXPANDED_INSTANCES} 个，请减少 array 数量或简化结构`);
    const mode = node.mode || 'radial';
    const angle = node.angle ?? 360;
    const spacing = mode === 'radial' ? (angle >= 360 ? 360 / count : angle / (count - 1)) : 0;
    const children = [];
    for (let i = 0; i < count; i++) {
      let matrix;
      if (mode === 'radial') {
        matrix = radialMatrix(node.axis || 'y', node.center, spacing * i);
      } else {
        const step = node.step ?? [0, 0, 0];
        matrix = new THREE.Matrix4().makeTranslation(step[0] * i, step[1] * i, step[2] * i);
        if (node.rotateStep) {
          const rotation = new THREE.Euler(...node.rotateStep.map(n => THREE.MathUtils.degToRad(n) * i), 'XYZ');
          matrix.multiply(new THREE.Matrix4().makeRotationFromEuler(rotation));
        }
      }
      children.push(pushTransform(child, matrix));
    }
    const union = { kind: 'union', children };
    if (node.material) union.material = node.material;
    if (node.color) union.color = node.color;
    return union;
  }
  if (node.children) return { ...node, children: node.children.map(child => expandNode(child, budget)) };
  budget.instances++;
  if (budget.instances > MAX_EXPANDED_INSTANCES) throw new Error(`CAD 展开后图元实例超过 ${MAX_EXPANDED_INSTANCES} 个，请减少 array 数量或简化结构`);
  return node;
}

/** 展开 mirror/array 为纯图元+布尔树，并统计展开规模。 */
export function expandCadModel(model) {
  const budget = { instances: 0 };
  const root = expandNode(model.model, budget);
  let nodes = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (++nodes > MAX_EXPANDED_NODES) throw new Error(`CAD 展开后节点超过 ${MAX_EXPANDED_NODES} 个，请简化结构`);
    if (node.children) stack.push(...node.children);
  }
  return { root, instances: budget.instances, expandedNodes: nodes };
}

/** 归一化模型输出：容忍裸节点数组或裸节点（缺少 units/model 包装）。 */
function normalizeCadValue(value) {
  if (Array.isArray(value)) {
    const children = value.filter(item => item && typeof item === 'object');
    if (!children.length) return value;
    return { units: 'mm', model: children.length === 1 ? children[0] : { kind: 'union', children } };
  }
  if (value && typeof value === 'object' && !('model' in value) && typeof value.kind === 'string') {
    return { units: 'mm', model: value };
  }
  return value;
}

/** 解析并校验扩展 CadModel；返回声明模型与规模统计。 */
export function parseExtendedCadModel(value) {
  const parsed = extendedCadModelSchema.safeParse(normalizeCadValue(value));
  if (!parsed.success) throw new Error('CAD 结构校验失败：' + JSON.stringify(parsed.error.issues).slice(0, 5000));
  const model = parsed.data;
  if (model.units !== 'mm') throw new Error('CAD 模型须使用 mm 单位，不能静默更改单位');
  const declaredNodes = validateDeclaredModel(model);
  return { model, declaredNodes };
}