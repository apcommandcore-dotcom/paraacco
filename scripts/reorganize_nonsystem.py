#!/usr/bin/env python3
# paraacco NAS 整理(不經 D1)reorganize_nonsystem.py V1.0(2026-09-28)
# CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第四節 C;依 PLAN-nas-filing-structure_20260927_V1.01.md 第三節。
#
# 只動「沒有 DOC id 的檔案」:已登記的 704 份(archive-plan 的 from 路徑)一律不碰,由 archive.py 搬並回寫。
# 已登記文件在舊制資料夾裡的「相同 SHA-256 複本」不是登記位置,照第 2 類處理(搬到待刪)。
#
#   1 受管區內的非單據(證券截圖、.md、zip、csv、tsv、影片、腳本、條款/報告、_audit_20260921/)
#       → ATLPAR_Bookkeeper/_系統外資料/<類別>/<原相對路徑>
#   2 舊制資料夾中受管區已有相同 SHA-256 的複本,以及已有解鎖版的加密原始下載檔(國泰/華南/台新/玉山)
#       → ATLPAR_Bookkeeper/_待刪除_舊制複本_20260927/<原相對路徑>
#   3 舊制獨有的非單據 → _系統外資料/<類別>/<原相對路徑>
#   4 舊制獨有的單據候選(及受管區內未登記成功的單據)→ Scanner/Bookkeeper_Scanner/_舊制匯入_20260927/<原相對路徑>
#       跨 share:複製 → 驗證 SHA-256 → 原檔搬到 _待刪除_舊制複本_20260927/(不直接刪)。之後由每日進件登記。
#   5 花旗、聯邦及另 3 份找不到解鎖版的加密檔 → Paraacco_公司財務系統/90_無法處理/加密無解鎖版/<銀行資料夾>/<檔名>
#   6 空的舊制資料夾不刪,--apply 完成後列在 _待刪除_舊制複本_20260927/_空資料夾清單_<時間>.txt
#
# 用法:
#   python3 reorganize_nonsystem.py                         產生計畫 reorganize-plan-<時間>.tsv 並停下
#   python3 reorganize_nonsystem.py --apply <plan.tsv>      Theo 確認後執行;記 reorganize-done-<時間>.tsv 與 ROLLBACK-reorganize-<時間>.sh
# 搬移前先驗證 SHA-256 與計畫一致;同一 share 內用 rename(不複製),跨 share 複製後再驗一次。
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import shlex
import shutil
import sys
from collections import Counter
from pathlib import Path

VERSION = "V1.0"
HOME = Path.home()
TZ = dt.timezone(dt.timedelta(hours=8))
SHARES = {
    "ATLPAR_Bookkeeper": Path(os.environ.get("ATLPAR_MOUNT", "/Volumes/ATLPAR_Bookkeeper")),
    "Scanner": Path(os.environ.get("SCANNER_MOUNT", "/Volumes/Scanner")),
}
OUT = Path(os.environ.get("OUT", HOME / "dev/_reports/paraacco/reorganize"))
BACKFILL = HOME / "dev/_reports/paraacco/backfill-20260926"
MANAGED = "Paraacco_公司財務系統"
OUTSIDE = "_系統外資料"
TRASH = "_待刪除_舊制複本_20260927"
IMPORT = "Bookkeeper_Scanner/_舊制匯入_20260927"
ENC_DIR = f"{MANAGED}/90_無法處理/加密無解鎖版"
NO_UNLOCK_BANKS = ("021_花旗銀行", "803_聯邦銀行")
NO_UNLOCK_EXTRA = (
    "806_元大銀行/元大證券_信用契約書.pdf",
    "806_元大銀行/歷史交易明細/",
    "812_台新銀行/銀行對帳單/",
)

EXT_CATEGORY = {
    ".md": "辨識側錄與報告",
    ".zip": "壓縮檔", ".rar": "壓縮檔", ".7z": "壓縮檔",
    ".mov": "影片", ".mp4": "影片", ".m4v": "影片",
    ".sh": "腳本", ".py": "腳本",
    ".csv": "工作檔", ".tsv": "工作檔", ".xlsx": "工作檔", ".xls": "工作檔", ".xml": "工作檔",
    ".odt": "工作檔", ".docx": "工作檔", ".doc": "工作檔", ".txt": "工作檔", ".indd": "工作檔", ".numbers": "工作檔",
    ".html": "網站原始碼", ".htm": "網站原始碼", ".js": "網站原始碼", ".css": "網站原始碼", ".sql": "網站原始碼",
    ".exe": "程式安裝檔", ".dmg": "程式安裝檔", ".pkg": "程式安裝檔",
    ".gif": "圖片", ".png": "圖片", ".jpg": "圖片", ".jpeg": "圖片",
}


def now_tag() -> str:
    return dt.datetime.now(TZ).strftime("%Y%m%d-%H%M%S")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def nondoc_category(rel: str) -> str:
    parts = rel.split("/")
    ext = os.path.splitext(rel)[1].lower()
    if parts[0] == MANAGED and len(parts) > 1 and parts[1] == "_audit_20260921":
        return "稽核資料"
    if parts[0] == MANAGED and "806_元大銀行" in rel and ext == ".png":
        return "證券庫存截圖"
    if parts[0] == "平行空間_網站事務明細" and ext not in (".mp4", ".mov", ".xlsx", ".csv"):
        return "網站原始碼"
    if ext.startswith(".loaded_"):
        return "網站原始碼"
    return EXT_CATEGORY.get(ext, "其他")


def build_plan(args) -> None:
    inv = [json.loads(line) for line in open(BACKFILL / "inv_all.jsonl")]
    archive_plan = list(csv.DictReader(open(args.archive_plan), delimiter="\t"))
    registered_paths = {r["from"] for r in archive_plan}
    registered_sha = {r["sha256"] for r in archive_plan}
    for line in open(HOME / "dev/paraacco/.batch-import-manifest.log"):
        registered_sha.add(line.split("\t")[0])
    for line in open(BACKFILL / "backfill-manifest.tsv"):
        registered_sha.add(line.split("\t")[0])
    legacy_unique = {r["path"]: r["類型"] for r in csv.DictReader(open(BACKFILL / "legacy_unique_20260927.csv", encoding="utf-8-sig"))}
    inventory = {r["path"]: r for r in csv.DictReader(open(BACKFILL / "inventory_20260926.tsv"), delimiter="\t")}
    managed_sha = {x["sha"] for x in inv if x["rel"].startswith(MANAGED + "/")}

    rows, skipped = [], []

    def add(step, cat, x, to_share, to_rel, action="mv", reason=""):
        rows.append({"step": step, "category": cat, "action": action, "from_share": "ATLPAR_Bookkeeper", "from": x["rel"],
                     "to_share": to_share, "to": to_rel, "sha256": x["sha"], "size": x["size"], "reason": reason})

    for x in inv:
        rel = x["rel"]
        if rel in registered_paths:
            continue  # 已登記的位置,由 archive.py 負責
        if rel.startswith(MANAGED + "/"):
            sub = rel[len(MANAGED) + 1:]
            if x["enc"] == "locked":
                if any(f"/{b}/" in f"/{sub}" for b in NO_UNLOCK_BANKS) or any(e in sub for e in NO_UNLOCK_EXTRA):
                    bank = sub.split("/")[1] if sub.startswith("01_SHR_信用卡帳單/") else sub.split("/")[0]
                    add(5, "加密無解鎖版", x, "ATLPAR_Bookkeeper", f"{ENC_DIR}/{bank}/{os.path.basename(rel)}", reason="加密且全 NAS 找不到解鎖版")
                else:
                    add(2, "加密原檔(已有解鎖版)", x, "ATLPAR_Bookkeeper", f"{TRASH}/{rel}", reason="同年月已有解鎖版(PLAN V1.01 第三節 2)")
                continue
            if x["sha"] in registered_sha:
                skipped.append((rel, "受管區內與已登記文件相同 SHA-256 的另一份複本,未列入(請人工確認)"))
                continue
            inv_row = inventory.get(sub)
            ext = os.path.splitext(rel)[1].lower()
            if inv_row and inv_row["status"] == "skip" and "非單據" in inv_row["reason"]:
                add(1, "條款與報告", x, "ATLPAR_Bookkeeper", f"{OUTSIDE}/條款與報告/{rel}", reason=inv_row["reason"])
            elif inv_row and inv_row["status"] == "upload" and ext in (".pdf", ".jpg", ".jpeg", ".png"):
                add(4, "受管區未登記單據", x, "Scanner", f"{IMPORT}/{rel}", action="copy_park", reason="回填時登記失敗(檔名含逗號),改走一般進件")
            else:
                cat = nondoc_category(rel)
                add(1, cat, x, "ATLPAR_Bookkeeper", f"{OUTSIDE}/{cat}/{rel}", reason="受管區內的非單據")
            continue
        # 舊制資料夾
        kind = legacy_unique.get(rel)
        if kind is None:
            if x["sha"] in managed_sha:
                add(2, "舊制複本", x, "ATLPAR_Bookkeeper", f"{TRASH}/{rel}", reason="受管區已有相同 SHA-256")
            else:
                skipped.append((rel, "不在獨有清單、受管區也沒有相同 SHA-256(請人工確認)"))
        elif kind == "非單據":
            cat = nondoc_category(rel)
            add(3, cat, x, "ATLPAR_Bookkeeper", f"{OUTSIDE}/{cat}/{rel}", reason="舊制獨有的非單據")
        else:
            add(4, "舊制單據候選", x, "Scanner", f"{IMPORT}/{rel}", action="copy_park", reason="舊制獨有,改走一般進件")

    # 目的地重名檢查
    dests = Counter((r["to_share"], r["to"]) for r in rows)
    for r in rows:
        if dests[(r["to_share"], r["to"])] > 1:
            base, ext = os.path.splitext(r["to"])
            r["to"] = f"{base}_{r['sha256'][:8]}{ext}"
    # 計畫當下存在性檢查
    for r in rows:
        p = SHARES["ATLPAR_Bookkeeper"] / r["from"]
        if not p.is_file():
            r["reason"] += ";⚠ 計畫當下找不到檔案"
        elif p.stat().st_size != int(r["size"]):
            r["reason"] += ";⚠ 大小與盤點不符"
        if (SHARES[r["to_share"]] / r["to"]).exists():
            r["reason"] += ";⚠ 目的地已有檔案"

    OUT.mkdir(parents=True, exist_ok=True)
    tag = now_tag()
    plan = OUT / f"reorganize-plan-{tag}.tsv"
    fields = ["step", "category", "action", "from_share", "from", "to_share", "to", "sha256", "size", "reason"]
    with open(plan, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter="\t")
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: (r["step"], r["category"], r["from"])))
    skip_path = OUT / f"reorganize-skipped-{tag}.tsv"
    with open(skip_path, "w", newline="") as f:
        csv.writer(f, delimiter="\t").writerows([("path", "reason"), *skipped])

    print(f"計畫:{plan}({len(rows)} 筆,{sum(int(r['size']) for r in rows) / 1e9:.2f} GB)")
    for (step, cat), n in sorted(Counter((r["step"], r["category"]) for r in rows).items()):
        print(f"  {step}  {cat}\t{n}")
    warn = sum(1 for r in rows if "⚠" in r["reason"])
    print(f"  需注意(⚠):{warn}")
    print(f"未列入計畫:{skip_path}({len(skipped)} 筆)")
    print(f"確認後執行:python3 {Path(__file__).name} --apply {plan}")


def apply(plan_path: Path) -> int:
    rows = list(csv.DictReader(open(plan_path), delimiter="\t"))
    for share, mp in SHARES.items():
        if not mp.is_dir():
            print(f"ABORT {share} 未掛載:{mp}")
            return 1
    tag = now_tag()
    done_path = OUT / f"reorganize-done-{tag}.tsv"
    rb_path = OUT / f"ROLLBACK-reorganize-{tag}.sh"
    log_path = OUT / f"reorganize-{tag}.log"
    ok = fail = 0
    with open(done_path, "w", newline="") as done_f, open(rb_path, "w") as rb, open(log_path, "a") as logf:
        done = csv.writer(done_f, delimiter="\t")
        done.writerow(["step", "action", "old", "new", "parked", "sha256", "at"])
        rb.write(f"#!/bin/bash\n# 回滾 {plan_path.name}({tag}):把檔案搬回原位。跨 share 的複本移到 Scanner/_回滾_舊制匯入_{tag}/(不刪除)。\n"
                 "# 若 _舊制匯入 的檔案已經被每日進件登記,不要回滾那幾筆。\nset -u\n")
        rb_lines = []

        def log(msg):
            line = f"{dt.datetime.now(TZ).strftime('%H:%M:%S')} {msg}"
            print(line)
            logf.write(line + "\n")

        for r in rows:
            src = SHARES[r["from_share"]] / r["from"]
            dst = SHARES[r["to_share"]] / r["to"]
            try:
                if not src.is_file():
                    raise RuntimeError("來源不存在")
                if dst.exists():
                    raise RuntimeError("目的地已有檔案")
                if sha256_file(src) != r["sha256"]:
                    raise RuntimeError("SHA-256 與計畫不符(檔案被改過?)")
                dst.parent.mkdir(parents=True, exist_ok=True)
                parked = ""
                if r["action"] == "mv":
                    os.rename(src, dst)
                    if dst.stat().st_size != int(r["size"]):
                        os.rename(dst, src)
                        raise RuntimeError("搬移後大小不符,已搬回")
                    rb_lines.append(f"mkdir -p {shlex.quote(str(src.parent))} && mv -n {shlex.quote(str(dst))} {shlex.quote(str(src))}")
                else:  # copy_park:跨 share 複製 → 驗證 → 原檔搬到待刪
                    shutil.copy2(src, dst)
                    if sha256_file(dst) != r["sha256"]:
                        bad = SHARES["ATLPAR_Bookkeeper"] / TRASH / "_複製驗證失敗" / r["from"]
                        bad.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(dst), str(bad))
                        raise RuntimeError("複製後 SHA-256 不符,複本已移到 _待刪除_…/_複製驗證失敗/")
                    park = SHARES["ATLPAR_Bookkeeper"] / TRASH / r["from"]
                    if park.exists():
                        raise RuntimeError(f"待刪資料夾已有同名檔案,原檔保留:{park}")
                    park.parent.mkdir(parents=True, exist_ok=True)
                    os.rename(src, park)
                    parked = str(park)
                    rb_back = SHARES["Scanner"] / f"_回滾_舊制匯入_{tag}" / r["from"]
                    rb_lines.append(f"mkdir -p {shlex.quote(str(src.parent))} && mv -n {shlex.quote(str(park))} {shlex.quote(str(src))}")
                    rb_lines.append(f"mkdir -p {shlex.quote(str(rb_back.parent))} && mv -n {shlex.quote(str(dst))} {shlex.quote(str(rb_back))}")
                done.writerow([r["step"], r["action"], str(src), str(dst), parked, r["sha256"], now_tag()])
                ok += 1
                if ok % 100 == 0:
                    log(f"進度 {ok}/{len(rows)}")
            except Exception as e:  # noqa: BLE001
                fail += 1
                log(f"FAIL {r['from']} -> {r['to']}:{e}")
        rb.write("\n".join(reversed(rb_lines)) + "\n")
    rb_path.chmod(0o755)

    # 6. 空的舊制資料夾清單(不刪)
    empties = []
    root = SHARES["ATLPAR_Bookkeeper"]
    for top in sorted({r["from"].split("/")[0] for r in rows if not r["from"].startswith(MANAGED + "/")} | {MANAGED}):
        has_files: dict[str, bool] = {}
        for dirpath, dirnames, filenames in os.walk(root / top, topdown=False):
            visible = any(f not in (".DS_Store", "Thumbs.db") and not f.startswith("._") for f in filenames)
            has_files[dirpath] = visible or any(has_files.get(os.path.join(dirpath, d), True) for d in dirnames)
            if not has_files[dirpath]:
                empties.append(dirpath)
    empty_list = root / TRASH / f"_空資料夾清單_{tag}.txt"
    empty_list.parent.mkdir(parents=True, exist_ok=True)
    empty_list.write_text("# reorganize_nonsystem.py 完成後仍為空的資料夾(未刪除,由 Theo 自行刪除)\n" + "\n".join(empties) + "\n")
    print(f"完成:成功 {ok}、失敗 {fail}。對照表 {done_path};回滾 {rb_path};空資料夾清單 {empty_list}({len(empties)} 個)")
    return 0 if fail == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="NAS 非單據與舊制複本整理(不經 D1;先出計畫,確認後 --apply)")
    ap.add_argument("--apply", metavar="PLAN_TSV")
    ap.add_argument("--archive-plan", help="archive.py 產生的遷移計畫(用來排除已登記的檔案位置)")
    args = ap.parse_args()
    if args.apply:
        return apply(Path(args.apply))
    if not args.archive_plan:
        plans = sorted((HOME / "dev/_reports/paraacco/archive").glob("archive-plan-*.tsv"))
        if not plans:
            ap.error("找不到 archive-plan,請用 --archive-plan 指定")
        args.archive_plan = str(plans[-1])
        print(f"排除已登記檔案:{args.archive_plan}")
    build_plan(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
