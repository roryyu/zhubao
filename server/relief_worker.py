#!/usr/bin/env python3
"""Neural relative-depth relief export. Read one JSON request from stdin.

The model predicts relative inverse depth, not metric dimensions or unseen
geometry. The caller explicitly supplies the relief's physical width/height.
No private CAD format is emitted or mimicked.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, ImageDraw
from scipy.ndimage import gaussian_filter, map_coordinates

MODE_HEIGHTS = {"浅浮雕": 1.0, "中浮雕": 3.0, "高浮雕": 6.0}


def normalize_depth(depth: np.ndarray) -> np.ndarray:
    depth = np.asarray(depth, dtype=np.float32).squeeze()
    if depth.ndim != 2 or not np.isfinite(depth).all():
        raise ValueError("深度模型返回的高度数据无效")
    lo, hi = np.percentile(depth, [1.0, 99.0])
    if hi - lo < 1e-7:
        raise ValueError("深度模型没有给出可分辨的深度变化")
    return gaussian_filter(np.clip((depth - lo) / (hi - lo), 0, 1), 0.65).astype(np.float32)


def infer_depth(image: Image.Image, model_path: Path) -> np.ndarray:
    import onnxruntime as ort

    if not model_path.is_file():
        raise ValueError("缺少本地深度模型，请先下载 Depth Anything V2 Small ONNX")
    if model_path.stat().st_size < 1024 * 1024:
        raise ValueError("深度模型文件不完整")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    spec = session.get_inputs()[0]
    if len(spec.shape) != 4:
        raise ValueError("深度模型输入维度不受支持")
    h, w = image.height, image.width
    if isinstance(spec.shape[2], int) and isinstance(spec.shape[3], int):
        out_h, out_w = spec.shape[2], spec.shape[3]
    else:
        # DPT lower-bound resize, multiples of 14, capped for pathological
        # aspect ratios. This preserves the source aspect ratio approximately.
        scale = 518.0 / min(h, w)
        if max(h, w) * scale > 1400:
            scale = 1400.0 / max(h, w)
        out_h = max(14, int(round(h * scale / 14)) * 14)
        out_w = max(14, int(round(w * scale / 14)) * 14)
    pixels = np.asarray(image.resize((out_w, out_h), Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
    pixels = (pixels - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    tensor = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])
    prediction = session.run(None, {spec.name: tensor})[0]
    depth = np.asarray(prediction, dtype=np.float32).squeeze()
    if depth.ndim != 2:
        raise ValueError("深度模型输出维度不受支持")
    return normalize_depth(depth)


def resize_float(values: np.ndarray, width: int, height: int) -> np.ndarray:
    return np.asarray(Image.fromarray(np.asarray(values, dtype=np.float32)).resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32)


def relief_mesh(depth: np.ndarray, width_mm: float, height_mm: float, relief_height: float, base_mm: float = 0.6):
    import trimesh

    h, w = depth.shape
    if h < 2 or w < 2:
        raise ValueError("浮雕网格尺寸过小")
    x, y = np.meshgrid(np.linspace(-width_mm / 2, width_mm / 2, w), np.linspace(height_mm / 2, -height_mm / 2, h))
    top = np.clip(depth, 0, 1) * relief_height + base_mm
    vertices = np.vstack([np.column_stack([x.ravel(), y.ravel(), top.ravel()]), np.column_stack([x.ravel(), y.ravel(), np.zeros(h * w)])]).astype(np.float64)
    a = (np.arange(h - 1)[:, None] * w + np.arange(w - 1)[None, :]).ravel()
    b, c, d = a + 1, a + w, a + w + 1
    n = h * w
    faces = [np.column_stack([a, c, b]), np.column_stack([b, c, d]), np.column_stack([a + n, b + n, c + n]), np.column_stack([b + n, d + n, c + n])]
    perimeter = np.concatenate([np.arange(h) * w, (h - 1) * w + np.arange(1, w), np.arange(h - 2, -1, -1) * w + w - 1, np.arange(w - 2, 0, -1)])
    q, r = perimeter, np.roll(perimeter, -1)
    faces.extend([np.column_stack([q, q + n, r + n]), np.column_stack([q, r + n, r])])
    mesh = trimesh.Trimesh(vertices=vertices, faces=np.vstack(faces), process=False)
    mesh.units = "mm"
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
        raise ValueError("生成的浮雕网格未通过封闭性和体积检查")
    return mesh, top


def source_lines(image: Image.Image, depth: np.ndarray, width_mm: float, height_mm: float, height: float, base_mm: float):
    from skimage.feature import canny
    from skimage.measure import find_contours, approximate_polygon

    size = 384
    gray = np.asarray(ImageOps.grayscale(image).resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32) / 255
    edges = canny(gray, sigma=1.2, low_threshold=0.08, high_threshold=0.2)
    contours = sorted(find_contours(edges.astype(np.float32), 0.5), key=len, reverse=True)
    lines = []
    for contour in contours[:250]:
        if len(contour) < 16:
            continue
        contour = approximate_polygon(contour, tolerance=0.7)
        if len(contour) < 3:
            continue
        coords = np.vstack([contour[:, 0] / (size - 1) * (depth.shape[0] - 1), contour[:, 1] / (size - 1) * (depth.shape[1] - 1)])
        z = map_coordinates(depth, coords, order=1, mode="nearest") * height + base_mm + 0.002
        xyz = np.column_stack([(contour[:, 1] / (size - 1) - 0.5) * width_mm, (0.5 - contour[:, 0] / (size - 1)) * height_mm, z])
        lines.append(xyz)
    return lines


def write_dxf(path: Path, mesh, lines) -> None:
    """ASCII DXF R2010; millimetres; 3DFACE mesh + genuine 3D polylines."""
    import ezdxf

    document = ezdxf.new("R2010", units=ezdxf.units.MM)
    document.header["$MEASUREMENT"] = 1
    document.layers.new("RELIEF", dxfattribs={"color": 7})
    document.layers.new("SOURCE_LINES", dxfattribs={"color": 1})
    space = document.modelspace()
    for face in mesh.faces:
        space.add_3dface(mesh.vertices[face], dxfattribs={"layer": "RELIEF"})
    for points in lines:
        closed = bool(np.linalg.norm(points[0, :2] - points[-1, :2]) < 0.15)
        space.add_polyline3d(points, close=closed, dxfattribs={"layer": "SOURCE_LINES"})
    document.saveas(path)


def shaded_preview(top: np.ndarray, width_mm: float, height_mm: float, path: Path, lines=()) -> None:
    dy, dx = np.gradient(top, -height_mm / (top.shape[0] - 1), width_mm / (top.shape[1] - 1))
    normals = np.stack([-dx, -dy, np.ones_like(top)], axis=-1)
    normals /= np.maximum(np.linalg.norm(normals, axis=-1, keepdims=True), 1e-8)
    light = np.array([-0.4, 0.45, 0.8]); light /= np.linalg.norm(light)
    lambert = np.clip(normals @ light, 0, 1)
    shading = 0.22 + 0.78 * lambert
    color = np.clip(shading[..., None] * np.array([224, 177, 84]), 0, 255).astype(np.uint8)
    image = Image.fromarray(color)
    scale = 768 / max(image.size)
    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
    if lines:
        drawing = ImageDraw.Draw(image)
        for points in lines:
            xy = [((float(p[0]) / width_mm + 0.5) * (image.width - 1), (0.5 - float(p[1]) / height_mm) * (image.height - 1)) for p in points]
            drawing.line(xy, fill=(58, 38, 12), width=1)
    image.save(path)


def export_relief(image: Image.Image, depth: np.ndarray, request: dict) -> dict:
    import OpenEXR
    import tifffile

    out = Path(request["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    basename = request.get("basename", "relief")
    if not isinstance(basename, str) or not basename or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in basename):
        raise ValueError("输出文件名只能包含字母、数字、短横线和下划线")
    mode = request.get("mode", "中浮雕")
    if mode not in MODE_HEIGHTS:
        raise ValueError("浮雕模式无效")
    if request.get("longEdgeMm") is not None:
        long_edge = float(request["longEdgeMm"])
        if not 0.1 <= long_edge <= 10000:
            raise ValueError("浮雕长边必须在 0.1～10000 mm 范围内")
        width = long_edge * image.width / max(image.size)
        height = long_edge * image.height / max(image.size)
    else:
        width = float(request.get("widthMm", 100))
        raw_height = request.get("heightMm")
        height = float(width * image.height / image.width if raw_height is None else raw_height)
        if not (0.1 <= width <= 10000 and 0.1 <= height <= 10000):
            raise ValueError("浮雕宽高必须在 0.1～10000 mm 范围内")
    feature = request.get("feature", "relief")
    if feature not in {"relief", "lineart"}:
        raise ValueError("浮雕功能类型无效")
    grid = int(request.get("gridSize", 128))
    if not 16 <= grid <= 256:
        raise ValueError("网格分辨率必须在 16～256 范围内")
    if image.width >= image.height:
        nx, ny = grid + 1, max(17, round(grid * image.height / image.width) + 1)
    else:
        ny, nx = grid + 1, max(17, round(grid * image.width / image.height) + 1)
    depth_grid = np.clip(resize_float(depth, nx, ny), 0, 1)
    relief_height, base_mm = MODE_HEIGHTS[mode], 0.6
    mesh, top = relief_mesh(depth_grid, width, height, relief_height, base_mm)
    # Preserve a higher-resolution height field independently of mesh density.
    map_size = min(1024, max(image.size))
    mw, mh = max(2, round(image.width * map_size / max(image.size))), max(2, round(image.height * map_size / max(image.size)))
    depth_map = np.clip(resize_float(depth, mw, mh), 0, 1)
    pixels = np.rint(depth_map * 65535).astype(np.uint16)
    paths = {extension: out / f"{basename}.{extension.lower()}" for extension in ["PNG", "TIF", "EXR", "STL", "GLB", "DXF"]}
    metadata = {"units": "millimeter", "width_mm": width, "height_mm": height, "long_edge_mm": max(width, height), "base_thickness_mm": base_mm, "relief_range_mm": relief_height, "height_formula": "z_mm = base_thickness_mm + sample_uint16 / 65535 * relief_range_mm", "depth_kind": "neural relative inverse depth, not metric measurement", "mode": mode, "feature": feature}
    Image.fromarray(pixels).save(paths["PNG"])
    tifffile.imwrite(paths["TIF"], pixels, photometric="minisblack", metadata=metadata, resolution=((mw - 1) / width * 10, (mh - 1) / height * 10), resolutionunit="CENTIMETER")
    OpenEXR.File({"units": "millimeter", "reliefRangeMm": float(relief_height), "baseThicknessMm": float(base_mm)}, {"Z": (base_mm + depth_map * relief_height).astype(np.float32)}).write(str(paths["EXR"]))
    mesh.export(str(paths["STL"]))
    # glTF uses metres. STL and DXF use millimetres, and metadata records both.
    glb_mesh = mesh.copy()
    glb_mesh.vertices *= 0.001
    glb_mesh.units = "m"
    glb_mesh.metadata.update({"source_units": "millimeter", "width_mm": width, "height_mm": height, "base_thickness_mm": base_mm, "relief_range_mm": relief_height, "method": "neural relative-depth height field"})
    glb_mesh.visual.face_colors = [202, 159, 75, 255]
    glb_mesh.export(str(paths["GLB"]))
    lines = source_lines(image, depth_grid, width, height, relief_height, base_mm) if feature == "lineart" else []
    dxf_depth = resize_float(depth_grid, min(nx, 65), min(ny, 65))
    dxf_mesh, _ = relief_mesh(dxf_depth, width, height, relief_height, base_mm)
    write_dxf(paths["DXF"], dxf_mesh, lines)
    preview_path = out / f"{basename}-preview.png"
    shaded_preview(top, width, height, preview_path, lines)
    stats = {"vertices": len(mesh.vertices), "triangles": len(mesh.faces), "watertight": bool(mesh.is_watertight), "windingConsistent": bool(mesh.is_winding_consistent), "volumeMm3": float(mesh.volume), "widthMm": width, "heightMm": height, "longEdgeMm": max(width, height), "zMinMm": float(mesh.bounds[0, 2]), "zMaxMm": float(mesh.bounds[1, 2]), "reliefHeightMm": relief_height, "baseThicknessMm": base_mm, "heightMapBits": 16, "heightMapWidth": mw, "heightMapHeight": mh, "linePolylines": len(lines), "dxfTriangles": len(dxf_mesh.faces), "stlUnits": "millimeter", "glbUnits": "meter", "dxfUnits": "millimeter", "exrChannel": "Z", "exrUnits": "millimeter"}
    manifest = {"files": {key: str(value) for key, value in paths.items()}, "previewPath": str(preview_path), "depthPath": str(paths["PNG"]), "stats": stats, "method": "Depth Anything V2 Small neural relative inverse depth; positive closed height-field relief", "scaleNote": "单图相对深度由神经模型推断；1/3/6 mm 为用户所选浮雕高度，不是照片中的真实尺寸测量。GLB 使用米，STL/DXF 使用毫米。", "manufacturingNote": "这是高度场浮雕，不是完整物体的背面重建；未完成刀具、公差、材料和加工可行性验证。"}
    (out / f"{basename}-metadata.json").write_text(json.dumps({**metadata, **manifest}, ensure_ascii=False, indent=2), encoding="utf8")
    manifest["metadataPath"] = str(out / f"{basename}-metadata.json")
    return manifest


def main():
    request = json.load(sys.stdin)
    image_path = Path(request["imagePath"]).resolve()
    if not image_path.is_file():
        raise ValueError("输入图片不存在")
    source = ImageOps.exif_transpose(Image.open(image_path))
    if source.width < 20 or source.height < 20 or source.width * source.height > 40_000_000:
        raise ValueError("输入图片尺寸不受支持")
    if "A" in source.getbands() or "transparency" in source.info:
        rgba = source.convert("RGBA")
        image = Image.new("RGBA", rgba.size, "white")
        image.alpha_composite(rgba)
        image = image.convert("RGB")
    else:
        image = source.convert("RGB")
    model_path = Path(request["depthModelPath"]).resolve()
    result = export_relief(image, infer_depth(image, model_path), request)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
