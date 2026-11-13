#!/usr/bin/env python3
"""File-format and geometry checks; no synthetic depth enters production CLI."""
import importlib.util
import json
import tempfile
from pathlib import Path

import numpy as np
import OpenEXR
import tifffile
import trimesh
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("relief_worker", ROOT / "server/relief_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def main():
    with tempfile.TemporaryDirectory(prefix="cjzb-relief-test-") as folder:
        image = Image.new("RGB", (128, 96), "white")
        drawing = ImageDraw.Draw(image)
        drawing.ellipse((20, 10, 108, 86), outline="black", width=3)
        drawing.line((30, 70, 64, 20, 98, 70), fill="black", width=2)
        y, x = np.mgrid[-1:1:96j, -1:1:128j]
        # This analytic surface is strictly a geometry/export fixture. The
        # production CLI always invokes the neural model and has no override.
        depth = np.exp(-3 * (x*x + y*y)).astype(np.float32)
        reports = []
        for mode in ["浅浮雕", "中浮雕", "高浮雕"]:
            result = worker.export_relief(image, depth, {"outputDir": folder, "basename": {"浅浮雕":"low","中浮雕":"mid","高浮雕":"high"}[mode], "mode":mode, "feature":"lineart", "widthMm":80,"gridSize":32})
            paths = result["files"]
            assert set(paths) == {"PNG", "TIF", "EXR", "STL", "GLB", "DXF"}
            for path in paths.values():
                assert Path(path).stat().st_size > 40, path
            tiff = tifffile.imread(paths["TIF"])
            png = np.asarray(Image.open(paths["PNG"]))
            assert tiff.dtype == np.uint16 and np.array_equal(tiff, png)
            assert 0 <= tiff.min() < tiff.max() <= 65535
            exr = OpenEXR.File(paths["EXR"]).channels()["Z"].pixels
            expected = 0.6 + tiff.astype(np.float64) / 65535 * worker.MODE_HEIGHTS[mode]
            assert exr.dtype == np.float32
            assert np.max(np.abs(exr - expected)) < worker.MODE_HEIGHTS[mode] / 65535 + 1e-5
            stl = trimesh.load(paths["STL"], force="mesh", process=True)
            assert stl.is_watertight and stl.is_winding_consistent and stl.volume > 0
            assert np.all(stl.area_faces > 0)
            assert abs(stl.extents[0] - 80) < 1e-5 and abs(stl.extents[1] - 60) < 1e-5
            assert abs(stl.bounds[0,2]) < 1e-6
            glb = trimesh.load(paths["GLB"], force="mesh", process=True)
            assert np.max(np.abs(glb.extents * 1000 - stl.extents)) < 1e-4
            dxf = Path(paths["DXF"]).read_text()
            pairs = dxf.splitlines()
            pairs = [(pairs[n].strip(), pairs[n + 1].strip()) for n in range(0, len(pairs), 2)]
            assert ("9", "$INSUNITS") in pairs and ("0", "3DFACE") in pairs
            assert "\nPOLYLINE\n" in dxf and "SOURCE_LINES" in dxf
            try:
                import ezdxf
                cad = ezdxf.readfile(paths["DXF"])
                assert cad.header["$INSUNITS"] == 4
                assert len(cad.modelspace().query("3DFACE")) == result["stats"]["dxfTriangles"]
                assert len(cad.modelspace().query("POLYLINE")) == result["stats"]["linePolylines"]
                audit = cad.audit()
                assert not audit.has_errors and not audit.fixes
            except ImportError:
                pass  # Parser-independent geometry and group-code checks above.
            assert result["stats"]["linePolylines"] > 0
            assert "relative" in result["method"] and "真实尺寸测量" in result["scaleNote"]
            reports.append({"mode":mode, **result["stats"]})
        assert reports[0]["volumeMm3"] < reports[1]["volumeMm3"] < reports[2]["volumeMm3"]
        portrait = Image.new("RGB", (64, 128), "white")
        result = worker.export_relief(portrait, depth, {"outputDir": folder, "basename":"portrait", "mode":"浅浮雕", "feature":"relief", "longEdgeMm":100,"gridSize":16})
        assert result["stats"]["widthMm"] == 50 and result["stats"]["heightMm"] == 100
        portrait_mesh = trimesh.load(result["files"]["STL"], force="mesh", process=True)
        assert np.max(np.abs(portrait_mesh.extents[:2] - [50, 100])) < 1e-6
        try:
            worker.infer_depth(image, Path(folder)/"missing.onnx")
            raise AssertionError("Missing model must not fall back to image brightness")
        except ValueError as error:
            assert "缺少本地深度模型" in str(error)
        print(json.dumps({"passed":True,"checks":["16-bit TIFF/PNG roundtrip", "float32 EXR height values", "watertight positive-volume STL", "GLB metre scale", "DXF millimetre mesh and source lines", "three relief mode heights", "portrait long-edge scale", "missing model rejects"],"reports":reports},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
