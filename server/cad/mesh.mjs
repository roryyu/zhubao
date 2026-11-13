import * as THREE from 'three';
import { ADDITION, SUBTRACTION, INTERSECTION, Brush, Evaluator } from 'three-bvh-csg';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { isCadBoolean } from '../../vendor/create-3d-things/cad.ts';
import { createCadMaterial, resolveCadMaterial } from '../../vendor/create-3d-things/cad-renderer.ts';

/**
 * 扩展 CAD 网格构建器。材质与布尔求值沿用 vendor/create-3d-things 的实现，
 * 这里增加 lathe/extrude/tube/capsule/roundedBox 图元、负缩放（镜像副本）
 * 的绕序修正、折痕角法线平滑与居中落地。mirror/array 已在 DSL 层展开。
 */

function makePrimitiveGeometry(node, quality) {
  const s = node.size || {};
  const seg = base => Math.max(8, Math.round(base * quality));
  switch (node.kind) {
    case 'box': return new THREE.BoxGeometry(s.w ?? 10, s.h ?? 10, s.d ?? 10);
    case 'cylinder': return new THREE.CylinderGeometry(s.radiusTop ?? s.radius ?? 5, s.radiusBottom ?? s.radius ?? 5, s.height ?? 10, seg(64), 1);
    case 'sphere': return new THREE.SphereGeometry(s.radius ?? 5, seg(64), seg(48));
    case 'cone': return new THREE.ConeGeometry(s.radius ?? 5, s.height ?? 10, seg(64), 1);
    case 'torus': return new THREE.TorusGeometry(s.radius ?? 6, s.tube ?? 2, seg(32), seg(96));
    case 'capsule': return new THREE.CapsuleGeometry(s.radius ?? 2, s.length ?? 6, 8, seg(32));
    case 'roundedBox': {
      const w = s.w ?? 10, h = s.h ?? 10, d = s.d ?? 10;
      const radius = Math.min(s.radius ?? Math.min(w, h, d) * 0.15, Math.min(w, h, d) / 2 - 1e-3);
      return new RoundedBoxGeometry(w, h, d, 4, Math.max(0.01, radius));
    }
    case 'lathe': {
      const points = node.profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
      return new THREE.LatheGeometry(points, node.segments ?? seg(96));
    }
    case 'extrude': {
      const shape = new THREE.Shape(node.outline.map(([x, y]) => new THREE.Vector2(x, y)));
      if (node.holes?.length) {
        shape.holes = node.holes.map(hole => new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
      }
      const bevel = node.bevel ?? 0;
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: node.depth,
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel * 0.8,
        bevelSegments: bevel > 0 ? 3 : 0,
        curveSegments: 12,
      });
      geometry.translate(0, 0, -node.depth / 2);
      return geometry;
    }
    case 'tube': {
      const points = node.path.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      const closed = node.closed ?? false;
      const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
      return new THREE.TubeGeometry(curve, node.segments ?? seg(64), s.radius, seg(20), closed);
    }
    default: throw new Error('不支持的几何类型');
  }
}

/** 镜像副本带负缩放：applyMatrix4 不会翻转绕序，这里手动修正，保证 CSG 法线正确。 */
function applyTransform(geometry, t) {
  if (!t) return;
  const rotation = new THREE.Euler(...(t.rotate ?? [0, 0, 0]).map(THREE.MathUtils.degToRad), 'XYZ');
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...(t.translate ?? [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(...(t.scale ?? [1, 1, 1])),
  );
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
      index.needsUpdate = true;
    } else {
      for (const name of Object.keys(geometry.attributes)) {
        const attribute = geometry.getAttribute(name);
        for (let i = 0; i < attribute.count; i += 3) {
          for (let c = 0; c < attribute.itemSize; c++) {
            const b = attribute.getComponent(i + 1, c);
            attribute.setComponent(i + 1, c, attribute.getComponent(i + 2, c));
            attribute.setComponent(i + 2, c, b);
          }
        }
        attribute.needsUpdate = true;
      }
    }
  }
}

/**
 * 折痕角法线平滑：同一材质组内，按位置焊接顶点，仅平均夹角小于 creaseDeg
 * 的相邻面法线。曲面（戒圈、宝石、胶囊）变光滑，布尔切边与倒角棱线保持锐利。
 */
function smoothCreaseNormals(geometry, creaseDeg = 42) {
  const position = geometry.getAttribute('position');
  if (!position || position.count < 3) return;
  const index = geometry.getIndex();
  const triCount = Math.floor((index ? index.count : position.count) / 3);
  const vertexOf = i => index ? index.getX(i) : i;
  const faceNormal = new Float32Array(triCount * 3);
  const faceGroup = new Int32Array(triCount);
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
  const groupOf = new Map();
  for (const [g, group] of groups.entries()) for (let i = group.start; i < group.start + group.count; i += 3) groupOf.set(i / 3, g);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), normal = new THREE.Vector3();
  const weldKey = v => `${Math.round(position.getX(v) * 1000)},${Math.round(position.getY(v) * 1000)},${Math.round(position.getZ(v) * 1000)}`;
  const weldFaces = new Map();
  for (let f = 0; f < triCount; f++) {
    const i0 = vertexOf(f * 3), i1 = vertexOf(f * 3 + 1), i2 = vertexOf(f * 3 + 2);
    a.fromBufferAttribute(position, i0); b.fromBufferAttribute(position, i1); c.fromBufferAttribute(position, i2);
    edge1.subVectors(b, a); edge2.subVectors(c, a); normal.crossVectors(edge1, edge2);
    if (normal.lengthSq() < 1e-16) continue;
    normal.normalize();
    faceNormal[f * 3] = normal.x; faceNormal[f * 3 + 1] = normal.y; faceNormal[f * 3 + 2] = normal.z;
    faceGroup[f] = groupOf.get(f) ?? 0;
    for (const v of [i0, i1, i2]) {
      const key = weldKey(v);
      let bucket = weldFaces.get(key);
      if (!bucket) weldFaces.set(key, bucket = []);
      bucket.push(f);
    }
  }
  const cosCrease = Math.cos(THREE.MathUtils.degToRad(creaseDeg));
  const normals = new Float32Array(position.count * 3);
  const written = new Uint8Array(position.count);
  for (let f = 0; f < triCount; f++) {
    const nx = faceNormal[f * 3], ny = faceNormal[f * 3 + 1], nz = faceNormal[f * 3 + 2];
    if (nx === 0 && ny === 0 && nz === 0) continue;
    for (let corner = 0; corner < 3; corner++) {
      const v = vertexOf(f * 3 + corner);
      if (written[v]) continue;
      written[v] = 1;
      let sx = 0, sy = 0, sz = 0;
      for (const adjacent of weldFaces.get(weldKey(v))) {
        if (faceGroup[adjacent] !== faceGroup[f]) continue;
        const dot = faceNormal[adjacent * 3] * nx + faceNormal[adjacent * 3 + 1] * ny + faceNormal[adjacent * 3 + 2] * nz;
        if (dot >= cosCrease) { sx += faceNormal[adjacent * 3]; sy += faceNormal[adjacent * 3 + 1]; sz += faceNormal[adjacent * 3 + 2]; }
      }
      const length = Math.hypot(sx, sy, sz) || 1;
      normals[v * 3] = sx / length; normals[v * 3 + 1] = sy / length; normals[v * 3 + 2] = sz / length;
    }
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}

/** 居中并落地：X/Z 中心归零，最低点贴 y=0，预览与三种导出格式一致。 */
function groundGeometry(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.computeBoundingBox();
}

const TARGET_TRIANGLES = 60000;
const MAX_TRIANGLES = 100000;

/** 估算单个图元在 quality=1 时的三角面数（保守偏高），用于全局细分预算。 */
function estimatePrimitiveTriangles(node) {
  const s = node.size || {};
  switch (node.kind) {
    case 'box': return 12;
    case 'cylinder': return 4 * 64;
    case 'sphere': return 64 * 48 * 2;
    case 'cone': return 3 * 64;
    case 'torus': return 32 * 96 * 2;
    case 'capsule': return 32 * 17 * 2;
    case 'roundedBox': return 600;
    case 'lathe': return (node.profile?.length || 4) * (node.segments || 96) * 2;
    case 'extrude': return (node.outline?.length || 4) * 12 + (node.holes?.length || 0) * 40;
    case 'tube': return (node.segments || 64) * 20 * 2;
    default: return 200;
  }
}

function estimateTotalTriangles(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.children) stack.push(...node.children);
    else total += estimatePrimitiveTriangles(node);
  }
  return total;
}

export function buildExtendedCadMesh(root, { instances = 1 } = {}) {
  // 按预估总面数推导全局细分系数：实例多或图元复杂时自动降细分，
  // 把总面数控制在导出上限内，避免密镶碎钻等场景面数爆炸。
  const estimate = Math.max(estimateTotalTriangles(root), instances * 200);
  const baseQuality = Math.min(1, Math.max(0.12, Math.sqrt(TARGET_TRIANGLES / estimate)));

  const attempt = quality => {
    const evaluator = new Evaluator();
    evaluator.useGroups = true;
    const materials = new Map();
    const brushes = new Set();
    let result;
    const getMaterial = spec => {
      const key = JSON.stringify(spec);
      if (!materials.has(key)) materials.set(key, createCadMaterial(spec));
      return materials.get(key);
    };
    const track = (geometry, material) => {
      const brush = new Brush(geometry, material);
      brushes.add(brush);
      brush.updateMatrixWorld();
      return brush;
    };
    const release = brush => {
      brush.disposeCacheData();
      brush.geometry.dispose();
      brushes.delete(brush);
    };
    const build = (node, inherited, forced) => {
      const spec = resolveCadMaterial(node, inherited);
      const material = forced ?? getMaterial(spec);
      if (!isCadBoolean(node)) {
        const brush = track(makePrimitiveGeometry(node, quality), material);
        applyTransform(brush.geometry, node.transform);
        return brush;
      }
      if (!node.children[0]) throw new Error('布尔节点缺少实体');
      let acc = build(node.children[0], spec, forced);
      const cutMaterial = Array.isArray(acc.material) ? acc.material[0] : acc.material;
      for (const child of node.children.slice(1)) {
        const b = build(child, spec, node.kind === 'union' ? forced : cutMaterial);
        const target = track(new THREE.BufferGeometry(), material);
        evaluator.evaluate(acc, b, { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION }[node.kind], target);
        target.updateMatrixWorld();
        release(acc);
        release(b);
        acc = target;
      }
      return acc;
    };
    try {
      result = build(root);
      const geometry = result.geometry;
      if (!geometry.getAttribute('position')?.count || geometry.drawRange.count === 0) throw new Error('布尔运算得到空模型，请调整描述');
      geometry.computeBoundingBox();
      const size = geometry.boundingBox.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(span) || span <= 0) throw new Error('模型尺寸无效');
      const used = new Set(Array.isArray(result.material) ? result.material : [result.material]);
      for (const material of materials.values()) {
        if (!used.has(material)) continue;
        material.userData.cad.uniforms.cadTextureSize.value = span;
        const spec = material.userData.cad.spec;
        if (spec.type === 'glass' && spec.thickness === undefined) material.thickness = span * 0.08;
      }
      smoothCreaseNormals(geometry);
      groundGeometry(geometry);
      const mesh = new THREE.Mesh(geometry, result.material);
      result.disposeCacheData();
      brushes.delete(result);
      for (const [key, material] of materials) {
        if (used.has(material)) materials.delete(key);
      }
      return mesh;
    } finally {
      for (const brush of brushes) release(brush);
      for (const material of materials.values()) material.dispose();
    }
  };

  let mesh = attempt(baseQuality);
  // 布尔求值可能新增面；若仍超导出上限，降一半细分重建一次兑底。
  const triCount = (mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute('position').count) / 3;
  if (triCount > MAX_TRIANGLES) {
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    mesh = attempt(Math.max(0.1, baseQuality * 0.5));
  }
  return mesh;
}