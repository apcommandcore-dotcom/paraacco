#!/usr/bin/env python3
# paraacco 回溯合併寫入 merge_objects.py V1.0(2026-09-29)
# CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 第三節「回溯」:Theo 在 merge-suggestions_*.tsv 勾選後才寫入。
#
#   預設(dry-run):python3 merge_objects.py <merge-suggestions.tsv> [--rule 2 --rule 4]
#     讀 accept 欄 = Y 的列(或 --rule N 整批接受該規則的列),依「建議物件」分組,印出要送的內容,不寫入。
#   確認後:加 --apply,每 20 個物件一批呼叫 POST /api/archive/purchase-objects(需 migration 0011 + API 部署)。
#     結果寫 merge-objects-done_<時間>.tsv;另外產生 ROLLBACK SQL(刪掉這次建的物件、品項、連結),必要時用 wrangler 執行。
#   已經屬於物件的文件、金額為負的主文件,API 逐筆回錯誤,不影響同批其他物件。
#
# 驗證:同 archive.py(Cloudflare Access Service Token + X-Extraction-Writeback-Token)。只用標準函式庫。
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from collections import OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from archive import ApiClient, ApiError  # noqa: E402  共用同一組驗證與 User-Agent

VERSION = "V1.0"
TZ = dt.timezone(dt.timedelta(hours=8))
BATCH = 20


def load_objects(path: Path, rules: set[int]) -> "OrderedDict[str, dict]":
    objects: "OrderedDict[str, dict]" = OrderedDict()
    with open(path, newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            accepted = r["accept"].strip().upper() in ("Y", "YES", "V", "1") or (rules and int(r["規則編號"]) in rules)
            if not accepted:
                continue
            o = objects.setdefault(r["建議物件"], {"primaryDocumentId": r["主文件"], "attachments": [], "note": f"{path.name} {r['建議物件']}"})
            item = r.get("品項行號", "").strip()
            o["attachments"].append({"documentId": r["附件"], "role": r["附件角色"].split()[0], "itemLineNo": int(item) if item else None})
    return objects


def main() -> int:
    ap = argparse.ArgumentParser(description="回溯合併:把勾選的合併建議寫成物件(預設 dry-run)")
    ap.add_argument("tsv", help="merge-suggestions_*.tsv(accept 欄填 Y 的列才處理)")
    ap.add_argument("--rule", type=int, action="append", default=[], help="整批接受某個規則編號(可重複)")
    ap.add_argument("--apply", action="store_true", help="真的寫入(呼叫 API)")
    args = ap.parse_args()
    path = Path(args.tsv).expanduser()
    objects = load_objects(path, set(args.rule))
    if not objects:
        print("沒有勾選的列(accept 欄填 Y,或用 --rule)。")
        return 1
    print(f"{VERSION}:{len(objects)} 個物件、{sum(len(o['attachments']) for o in objects.values())} 份附件")
    for key, o in objects.items():
        print(f"  {key} 主文件 {o['primaryDocumentId']} ← " + "、".join(f"{a['documentId']}({a['role']})" for a in o["attachments"]))
    if not args.apply:
        print("dry-run,沒有寫入。確認後加 --apply。")
        return 0

    tag = dt.datetime.now(TZ).strftime("%Y%m%d-%H%M%S")
    out = path.parent
    client = ApiClient()
    done, created = [], []
    payload = list(objects.items())
    for i in range(0, len(payload), BATCH):
        chunk = payload[i : i + BATCH]
        try:
            res = client.post("/archive/purchase-objects", {"objects": [o for _, o in chunk]})
        except ApiError as e:
            print(f"第 {i // BATCH + 1} 批失敗:{e};已完成的寫在 done 檔,重跑前先確認。")
            break
        for (key, o), r in zip(chunk, res["results"]):
            done.append([key, o["primaryDocumentId"], ",".join(a["documentId"] for a in o["attachments"]), "ok" if r["ok"] else r.get("error"), r.get("purchaseId", ""), r.get("message", "")])
            if r["ok"]:
                created.append(r["purchaseId"])
    done_path = out / f"merge-objects-done_{tag}.tsv"
    with open(done_path, "w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["建議物件", "主文件", "附件", "結果", "purchase_id", "訊息"])
        w.writerows(done)
    rb = out / f"ROLLBACK-merge-objects_{tag}.sql"
    ids = ",".join(f"'{p}'" for p in created)
    rb.write_text(
        f"-- merge_objects.py {VERSION} {tag}:刪掉這次建立的 {len(created)} 個物件(品項、非單據附件、文件連結)。文件本身不動。\n"
        + (
            f"DELETE FROM purchase_attachments WHERE purchase_id IN ({ids});\n"
            f"DELETE FROM document_purchase_links WHERE purchase_id IN ({ids});\n"
            f"DELETE FROM purchase_items WHERE purchase_id IN ({ids});\n"
            f"DELETE FROM purchases WHERE id IN ({ids});\n"
            if created
            else "-- (沒有建立任何物件)\n"
        )
    )
    print(f"完成:建立 {len(created)} 個物件。結果 {done_path};回退 SQL {rb}")
    return 0 if len(created) == len(objects) else 1


if __name__ == "__main__":
    sys.exit(main())
