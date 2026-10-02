#!/usr/bin/env python3
# paraacco NAS 原始檔完整性檢查 integrity_check.py V1.01(2026-09-28)
# V1.01:比對孤兒檔前把路徑做 Unicode NFC 正規化——macOS 的 SMB 會把含濁音的日文(ジ、パ…)回傳成 NFD,
#        線上存的是 NFC,V1.0 會誤報成孤兒檔。V1.0 唯讀保留。
# CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第四節 D;每週排程(org.parallelserver.paraacco.integrity-check.plist)。
#
#   1 線上每筆 storage='local' 的 local_path 都要存在,且 SHA-256 與登記值一致。
#   2 受管區(00_收件、10_–80_ 主體資料夾)裡沒有 DOC id 對應的檔案,列為孤兒檔。
#   報告:~/dev/_reports/paraacco/integrity/integrity-<日期>.md(摘要)與 .tsv(明細)。
#
# 來源:
#   預設            GET /api/archive/documents(分頁讀全部 storage=local 文件)
#   --plan <tsv>   API 部署前用:拿 archive.py 的計畫檔當「線上紀錄」(檢查 from 欄位)
# 只讀不寫:不搬檔、不改 D1。
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import os
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from archive import ApiClient, MANAGED_ROOT, MOUNT  # noqa: E402

VERSION = "V1.01"
TZ = dt.timezone(dt.timedelta(hours=8))
OUT = Path(os.environ.get("INTEGRITY_OUT", Path.home() / "dev/_reports/paraacco/integrity"))
ORPHAN_SCOPE = re.compile(r"^(00_收件|[1-8]0_[^/]+)$")
IGNORED_NAMES = {".DS_Store", "Thumbs.db"}


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def online_records(plan: str | None) -> list[dict]:
    if plan:
        return [{"documentId": r["doc_id"], "localPath": r["from"], "sha256": r["sha256"]} for r in csv.DictReader(open(plan), delimiter="\t")]
    client, out, after = ApiClient(), [], ""
    while True:
        res = client.get(f"/archive/documents?after={after}&limit=500")
        out.extend(res["documents"])
        after = res.get("next")
        if not after:
            return out


def main() -> int:
    ap = argparse.ArgumentParser(description="NAS 原始檔完整性檢查(只讀)")
    ap.add_argument("--plan", help="API 部署前:用 archive.py 計畫檔的 from 欄位當線上紀錄")
    ap.add_argument("--no-hash", action="store_true", help="只檢查存在與否,不算 SHA-256(快速)")
    args = ap.parse_args()

    if not (MOUNT / MANAGED_ROOT).is_dir():
        print(f"ABORT 受管區未掛載:{MOUNT / MANAGED_ROOT}")
        return 1
    records = online_records(args.plan)
    broken, mismatch, ok = [], [], 0
    known = set()
    for r in records:
        lp = r.get("localPath") or ""
        known.add(unicodedata.normalize("NFC", lp))
        p = MOUNT / lp
        if not lp or not p.is_file():
            broken.append((r["documentId"], lp, "檔案不存在"))
            continue
        if not args.no_hash and sha256_file(p) != r.get("sha256"):
            mismatch.append((r["documentId"], lp, "SHA-256 不符"))
            continue
        ok += 1

    orphans = []
    root = MOUNT / MANAGED_ROOT
    for top in sorted(os.listdir(root)):
        if not ORPHAN_SCOPE.match(top) or not (root / top).is_dir():
            continue
        for dirpath, _dirs, files in os.walk(root / top):
            for f in files:
                if f in IGNORED_NAMES or f.startswith("._"):
                    continue
                rel = str(Path(dirpath, f).relative_to(MOUNT))
                if unicodedata.normalize("NFC", rel) not in known:
                    orphans.append(("", rel, "受管區內沒有 DOC id 對應"))

    OUT.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(TZ).strftime("%Y%m%d-%H%M%S")
    tsv = OUT / f"integrity-{stamp}.tsv"
    with open(tsv, "w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["kind", "doc_id", "path", "detail"])
        for kind, rows in (("broken", broken), ("sha_mismatch", mismatch), ("orphan", orphans)):
            for doc_id, path, detail in rows:
                w.writerow([kind, doc_id, path, detail])
    md = OUT / f"integrity-{stamp}.md"
    source = f"計畫檔 {args.plan}" if args.plan else "GET /api/archive/documents"
    md.write_text(
        f"# NAS 原始檔完整性檢查 {stamp}\n\n"
        f"- 版本:integrity_check.py {VERSION}\n- 線上紀錄來源:{source}\n- SHA-256:{'略過(--no-hash)' if args.no_hash else '逐檔計算'}\n\n"
        "| 項目 | 筆數 |\n|---|---:|\n"
        f"| 線上 storage=local 紀錄 | {len(records)} |\n| 一致 | {ok} |\n| 路徑斷裂 | {len(broken)} |\n"
        f"| SHA-256 不符 | {len(mismatch)} |\n| 孤兒檔(00_收件、10_–80_) | {len(orphans)} |\n\n"
        f"明細:`{tsv}`\n"
    )
    print(md.read_text())
    return 0 if not broken and not mismatch else 2


if __name__ == "__main__":
    sys.exit(main())
