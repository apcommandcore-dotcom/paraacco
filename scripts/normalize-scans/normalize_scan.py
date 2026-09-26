#!/usr/bin/env python3
"""
paraacco 掃描單據正規化 V1.0(2026-09-26)——裁掉空白、自動轉正、重新壓縮成顯示用 PDF。

用途:產出 document_files kind='normalized_pdf' 的顯示檔,經
POST /api/extraction-writeback/documents/:id/normalized-file 上傳。原檔(kind='original')不動,
sha256 去重與 pipeline 擷取都只看原檔。

做法:
  1. pdftoppm 200dpi 灰階逐頁轉圖
  2. 裁切:縮圖 1/4 → 門檻 225 二值化 → 形態學去雜點 → 取內容外框(留 40px 邊)
  3. 轉正:RapidOCR(內建中文模型,ONNX)對 0/90/180/270 四個方向各跑一次辨識,取
     「信心 × 字數」總分最高的方向。tesseract OSD 對短收據、感熱紙誤判率高(2026-09-26 實測),
     不採用。
  4. 每頁 JPEG q60 灰階、200dpi 包回 PDF

需求:poppler-utils(pdftoppm)、Pillow、numpy、rapidocr-onnxruntime
    pip install pillow numpy rapidocr-onnxruntime

用法:
    python3 normalize_scan.py <輸入.pdf> <輸出.pdf>
    python3 normalize_scan.py --batch <輸入資料夾> <輸出資料夾> [--map manifest.tsv]
      --map:批次進件 manifest(sha\tDOC-id\t時間\t路徑),有給就把輸出檔命名成 DOC-id.pdf
"""
import argparse, glob, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageFilter

DPI = 200
JPEG_QUALITY = 60
_engine = None


def _ocr():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def content_bbox(im):
    sm = im.resize((im.width // 4, im.height // 4))
    m = sm.point(lambda v: 255 if v < 225 else 0)
    m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
    b = m.getbbox()
    if not b:
        return None
    pad = 10
    return (max(0, b[0] * 4 - 4 * pad), max(0, b[1] * 4 - 4 * pad), min(im.width, b[2] * 4 + 4 * pad), min(im.height, b[3] * 4 + 4 * pad))


def _text_score(im):
    res, _ = _ocr()(np.array(im.convert("RGB")), use_det=True, use_cls=False, use_rec=True)
    return sum(float(r[2]) * len(r[1]) for r in res) if res else 0.0


def best_rotation(im, max_side=900):
    small = im.copy()
    small.thumbnail((max_side, max_side))
    scores = {rot: _text_score(small.rotate(-rot, expand=True)) for rot in (0, 90, 180, 270)}
    return max(scores, key=scores.get), scores


def normalize(src, dst):
    info = []
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-gray", "-png", src, os.path.join(tmp, "p")], check=True)
        pages = []
        for pg in sorted(glob.glob(os.path.join(tmp, "p-*.png"))):
            im = Image.open(pg).convert("L")
            b = content_bbox(im)
            if b:
                im = im.crop(b)
            rot, scores = best_rotation(im)
            if rot:
                im = im.rotate(-rot, expand=True)
            pages.append(im)
            info.append({"rotated": rot, "scores": {k: round(v) for k, v in scores.items()}, "size": im.size})
        pages[0].save(dst, "PDF", resolution=DPI, save_all=True, append_images=pages[1:], quality=JPEG_QUALITY)
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", action="store_true")
    ap.add_argument("--map")
    ap.add_argument("src")
    ap.add_argument("dst")
    a = ap.parse_args()
    if not a.batch:
        print(json.dumps(normalize(a.src, a.dst), ensure_ascii=False))
        return
    names = {}
    if a.map:
        for line in open(a.map, encoding="utf-8"):
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 4:
                names[os.path.basename(parts[3])] = parts[1]
    os.makedirs(a.dst, exist_ok=True)
    report = {}
    for f in sorted(glob.glob(os.path.join(a.src, "*.pdf"))):
        base = os.path.basename(f)
        out = os.path.join(a.dst, (names.get(base) or base[:-4]) + ".pdf")
        info = normalize(f, out)
        report[base] = {"out": os.path.basename(out), "in_bytes": os.path.getsize(f), "out_bytes": os.path.getsize(out), "pages": info}
        print(base, "->", os.path.basename(out), report[base]["in_bytes"], "->", report[base]["out_bytes"], [p["rotated"] for p in info], flush=True)
    json.dump(report, open(os.path.join(a.dst, "_normalize_report.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
