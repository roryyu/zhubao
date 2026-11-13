#!/usr/bin/env python3
"""Software-rasterized preview renders for parametric CAD meshes.

Reads one JSON request from stdin, renders orthographic views of a binary STL
(Z-up, millimetres) with a numpy z-buffer, and writes PNG files. Used by the
model self-critique loop; no GPU, OpenGL or extra dependencies beyond the
geometry venv (numpy + Pillow).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

DEFAULT_VIEWS = [
    {"name": "front", "azimuth": 0.0, "elevation": 12.0},
    {"name": "side", "azimuth": 90.0, "elevation": 12.0},
    {"name": "top", "azimuth": 0.0, "elevation": 80.0},
]


def read_stl(path: Path) -> np.ndarray:
    data = path.read_bytes()
    if len(data) < 84:
        raise ValueError("STL 文件为空或损坏")
    count = int.from_bytes(data[80:84], "little")
    if count == 0 or len(data) < 84 + count * 50:
        raise ValueError("STL 三角面数量无效")
    record = np.dtype([("normal", "<3f4"), ("vertices", "<9f4"), ("attr", "<u2")])
    records = np.frombuffer(data, dtype=record, count=count, offset=84)
    triangles = records["vertices"].reshape(count, 3, 3).astype(np.float64)
    if not np.isfinite(triangles).all():
        raise ValueError("STL 包含无效顶点")
    return triangles


def render_view(triangles: np.ndarray, azimuth: float, elevation: float, size: int) -> Image.Image:
    az, el = np.deg2rad(azimuth), np.deg2rad(elevation)
    direction = np.array([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)])
    reference = np.array([0.0, 0.0, 1.0]) if abs(direction[2]) < 0.99 else np.array([0.0, 1.0, 0.0])
    right = np.cross(direction, reference)
    right /= np.linalg.norm(right)
    up = np.cross(right, direction)

    center = (triangles.reshape(-1, 3).min(axis=0) + triangles.reshape(-1, 3).max(axis=0)) / 2
    points = triangles - center
    half = float(np.abs(points).max()) * 1.15 or 1.0
    screen_x = points @ right
    screen_y = points @ up
    depth = points @ direction
    px = (screen_x / half * 0.5 + 0.5) * (size - 1)
    py = (1 - (screen_y / half * 0.5 + 0.5)) * (size - 1)

    edge1 = triangles[:, 1] - triangles[:, 0]
    edge2 = triangles[:, 2] - triangles[:, 0]
    normals = np.cross(edge1, edge2)
    lengths = np.linalg.norm(normals, axis=1)
    valid = lengths > 1e-12
    normals[valid] /= lengths[valid, None]
    # Double-sided shading: the mesh may be open, so flip normals toward camera.
    facing = normals @ direction < 0
    normals[facing] *= -1
    cam_normals = np.stack([normals @ right, normals @ up, normals @ direction], axis=1)

    key = np.array([0.4, 0.5, 0.75])
    key /= np.linalg.norm(key)
    fill = np.array([-0.6, -0.2, 0.4])
    fill /= np.linalg.norm(fill)
    half_vector = key + np.array([0.0, 0.0, 1.0])
    half_vector /= np.linalg.norm(half_vector)
    diffuse = 0.28 + 0.62 * np.maximum(cam_normals @ key, 0) + 0.22 * np.maximum(cam_normals @ fill, 0)
    specular = 0.35 * np.maximum(cam_normals @ half_vector, 0) ** 40
    base = np.array([0.80, 0.78, 0.75])
    colors = np.clip(diffuse[:, None] * base[None, :] + specular[:, None], 0, 1)

    z_buffer = np.full((size, size), -np.inf)
    image = np.ones((size, size, 3), dtype=np.float64)
    order = np.argsort(depth.mean(axis=1))  # far to near, fewer z-buffer writes
    for f in order:
        if not valid[f]:
            continue
        x0, x1, x2 = px[f]
        y0, y1, y2 = py[f]
        min_x = max(int(np.floor(min(x0, x1, x2))), 0)
        max_x = min(int(np.ceil(max(x0, x1, x2))), size - 1)
        min_y = max(int(np.floor(min(y0, y1, y2))), 0)
        max_y = min(int(np.ceil(max(y0, y1, y2))), size - 1)
        if min_x > max_x or min_y > max_y:
            continue
        xs = np.arange(min_x, max_x + 1) + 0.5
        ys = np.arange(min_y, max_y + 1) + 0.5
        grid_x, grid_y = np.meshgrid(xs, ys)
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-12:
            continue
        w0 = ((y1 - y2) * (grid_x - x2) + (x2 - x1) * (grid_y - y2)) / denom
        w1 = ((y2 - y0) * (grid_x - x2) + (x0 - x2) * (grid_y - y2)) / denom
        w2 = 1 - w0 - w1
        mask = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not mask.any():
            continue
        interpolated = w0 * depth[f, 0] + w1 * depth[f, 1] + w2 * depth[f, 2]
        region = z_buffer[min_y:max_y + 1, min_x:max_x + 1]
        closer = mask & (interpolated > region)
        if not closer.any():
            continue
        region[closer] = interpolated[closer]
        image[min_y:max_y + 1, min_x:max_x + 1][closer] = colors[f]
    return Image.fromarray((image * 255).astype(np.uint8), "RGB")


def main() -> None:
    request = json.loads(sys.stdin.read())
    stl_path = Path(request["stlPath"])
    out_dir = Path(request["outDir"])
    basename = str(request["basename"])
    size = int(request.get("size", 512))
    if not 128 <= size <= 1024:
        raise ValueError("预览尺寸须为 128～1024 像素")
    views = request.get("views") or DEFAULT_VIEWS
    if len(views) > 4:
        raise ValueError("预览视角最多 4 个")
    triangles = read_stl(stl_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for view in views:
        name = str(view["name"])
        if not name.replace("-", "").replace("_", "").isalnum():
            raise ValueError("预览视角名称无效")
        image = render_view(triangles, float(view.get("azimuth", 0)), float(view.get("elevation", 15)), size)
        path = out_dir / f"{basename}-{name}.png"
        image.save(path)
        outputs.append({"name": name, "path": str(path)})
    print(json.dumps({"views": outputs, "triangles": len(triangles)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - report structured error to caller
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)