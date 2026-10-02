#!/usr/bin/env python3
# paraacco NAS 原始檔歸檔 archive.py V1.0(2026-09-28)
# CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第四節 B、第五節;結構與命名依
# PLAN-nas-filing-structure_20260927_V1.01.md 第二節。
#
# 受管區 Paraacco_公司財務系統/ 內的原始檔,由這支腳本搬到 <主體>/<年>/<類別>/ 並改名成
#   YYYYMMDD_類型_對象_金額_DOC-2026-000123.<ext>
# 同步呼叫 POST /api/archive/moves 更新線上 local_path。
#
# 一律分兩步:
#   1) 產生計畫(預設):python3 archive.py --source migration|api
#        → <OUT>/archive-plan-<時間>.tsv(DOC id、from、to、sha256、主體、年、類別、備註)並停下。
#      --source migration:既有 704 份遷移。來源是 D1 快照(--d1-json,唯讀 SELECT 匯出)、全碟 SHA-256
#        盤點 inv_all.jsonl、寫回時的欄位(backfill bodies/*.json、extraction-writeback-payload_20260926.json)。
#        另外輸出 migrate-local-paths-<時間>.sql:把這批文件的 document_files 補成 storage='local'、
#        local_path=目前位置(第五節步驟 1,Theo 用 wrangler d1 execute --remote 執行)。
#      --source api:已覆核(status=archived)、檔案還在 00_收件 的文件,從 GET /api/archive/documents 讀。
#   2) Theo 確認計畫後:python3 archive.py --apply <plan.tsv> [--max-writes 800]
#        每批(≤50 份)先在 NAS 上搬檔(同一個 share 內 rename,不跨磁碟)→ 驗證 SHA-256 → 呼叫
#        /api/archive/moves 回寫(單一 D1 交易)→ 成功才記 archive-done-<日期>.tsv 與 ROLLBACK-<時間>.tsv。
#        回寫失敗(含 D1 每日額度用完):把這批已搬的檔案搬回原位、記錄進度後停止,隔天 --resume 接續。
#        回應不明(逾時、網路中斷):先用 GET /api/archive/documents 對帳,以線上紀錄為準決定留或搬回;
#        連不上就停下並標記 uncertain,--resume 會先對帳。不會留下「檔案已搬、線上還是舊路徑」的狀態。
#   --resume:讀 <OUT>/archive-state.json,接續上次的計畫。
#
# 驗證:Cloudflare Access Service Token(batch_ingest.env)+ X-Extraction-Writeback-Token。
# 只用標準函式庫;python3 3.9 相容。
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

VERSION = "V1.0"
HOME = Path.home()
MANAGED_ROOT = "Paraacco_公司財務系統"
MOUNT = Path(os.environ.get("MOUNT", "/Volumes/ATLPAR_Bookkeeper"))
OUT = Path(os.environ.get("OUT", HOME / "dev/_reports/paraacco/archive"))
API_BASE = os.environ.get("API_BASE", "https://acco-api.parallelserver.org/api")
CF_ENV = Path(os.environ.get("CF_ENV", HOME / ".config/paraacco-batch/batch_ingest.env"))
WB_TOKEN_FILE = Path(os.environ.get("WB_TOKEN_FILE", HOME / ".config/paraacco-batch/extraction_writeback.token"))
BACKFILL = HOME / "dev/_reports/paraacco/backfill-20260926"
EXTRACTION = HOME / "dev/_reports/paraacco/extraction-20260926"
BATCH_SIZE = min(int(os.environ.get("BATCH_SIZE", "50")), 50)  # API 上限 50
TZ = dt.timezone(dt.timedelta(hours=8))

ENTITY_TAX_IDS = {"83018456": "ap", "60277434": "studio"}
SUBJECT_DIRS = {"ap": "10_平行空間有限公司", "studio": "20_呂劭翊建築師事務所", "per": "30_家庭個人", "shared": "80_共用未分流"}
UNPROCESSABLE = "90_無法處理"

# 判讀備註的類型標籤 → (檔名類型, 類別資料夾)。類別固定 7 個(PLAN V1.01 第二節)。
TYPE_MAP = {
    "INV": ("發票", "01_發票收據"),
    "RCT": ("收據", "01_發票收據"),
    "DEL": ("出貨單", "01_發票收據"),
    "ORD": ("訂單", "01_發票收據"),
    "REFUND": ("退款", "01_發票收據"),
    "TRAVEL": ("旅費", "01_發票收據"),
    "UTIL": ("帳單", "02_帳單繳費"),
    "BIL": ("帳單", "02_帳單繳費"),
    "SUB": ("訂閱", "02_帳單繳費"),
    "INS": ("保險", "02_帳單繳費"),
    "GOV": ("稅費", "03_稅費規費"),
    "TAX": ("稅費", "03_稅費規費"),
    "CCS": ("信用卡帳單", "04_對帳單"),
    "SEC": ("證券對帳單", "04_對帳單"),
    "BNK": ("銀行對帳單", "04_對帳單"),
    "SAL": ("薪資", "05_薪資"),
    "WAR": ("保固書", "06_保固說明"),
    "MAN": ("說明書", "06_保固說明"),
    "MED": ("醫療", "07_醫療"),
}
COMPANY_SUFFIXES = ["股份有限公司", "有限公司", "事業處", "分公司", "公司", "(股)", "（股）"]


def now_tag() -> str:
    return dt.datetime.now(TZ).strftime("%Y%m%d-%H%M%S")


def today() -> str:
    return dt.datetime.now(TZ).strftime("%Y%m%d")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def abs_path(rel: str) -> Path:
    if not rel.startswith(MANAGED_ROOT + "/") or ".." in rel.split("/"):
        raise ValueError(f"不在受管區的路徑:{rel}")
    return MOUNT / rel


# ---------------------------------------------------------------------------
# 命名
# ---------------------------------------------------------------------------
def short_counterparty(name: str | None) -> str:
    s = (name or "").strip()
    for suf in COMPANY_SUFFIXES:
        s = s.replace(suf, "")
    s = re.sub(r'[\\/:*?"<>|\s]+', "", s).replace("_", "-")
    return s[:12] or "未知"


def fmt_amount(cents) -> str | None:
    if cents is None or cents == "":
        return None
    c = int(cents)
    return str(c // 100) if c % 100 == 0 else f"{c / 100:.2f}"


def date_parts(invoice_date: str | None, doc_date: str | None, period: str | None) -> tuple[str, str]:
    """回傳 (檔名日期 YYYYMMDD, 年資料夾)。只有年月時日寫 00;都沒有時 00000000 / 0000。"""
    for d in (invoice_date, doc_date):
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", d or "")
        if m:
            return "".join(m.groups()), m.group(1)
    m = re.match(r"^(\d{4})-(\d{2})", period or "")
    if m:
        return f"{m.group(1)}{m.group(2)}00", m.group(1)
    m = re.match(r"^(\d{2,3})\s*[年/.-]\s*(\d{1,2})", period or "")  # 民國年:111年11-12月、113/01
    if m and 1 <= int(m.group(2)) <= 12:
        y = int(m.group(1)) + 1911
        return f"{y}{int(m.group(2)):02d}00", str(y)
    return "00000000", "0000"


def tag_from_notes(notes: str | None) -> str | None:
    m = re.match(r"\s*\[([A-Z_]{2,12})\]", notes or "")
    return m.group(1) if m else None


def resolve_subject(ownership: str | None, confirmed: bool, buyer_tax_id: str | None, notes: str, tag: str | None, date8: str) -> tuple[str, str]:
    """回傳 (主體 key, 判斷依據)。"""
    if tag == "CCS" and date8 != "00000000" and date8 < "20260901":
        return "shared", "2026-09 前信用卡帳單"
    if not confirmed or not ownership:
        return "shared", "歸屬未確認"
    if ownership == "per":
        return "per", "ownership=per"
    if ownership != "corp":
        return "shared", f"ownership={ownership}"
    if buyer_tax_id in ENTITY_TAX_IDS:
        return ENTITY_TAX_IDS[buyer_tax_id], f"買方統編 {buyer_tax_id}"
    has_studio = "事務所" in notes
    has_ap = "平行空間" in notes
    if has_studio and not has_ap:
        return "studio", "備註含「事務所」"
    if has_ap and not has_studio:
        return "ap", "備註含「平行空間」"
    return "shared", "corp 但無法判斷是哪個主體"


def build_target(doc: dict) -> tuple[str, str]:
    """doc 需要:id, ext, tag, ownership, confirmed, buyer, notes, invoice_date, doc_date, period, vendor, amount。
    回傳 (目的相對路徑, 備註)。"""
    date8, year = date_parts(doc.get("invoice_date"), doc.get("doc_date"), doc.get("period"))
    tag = doc.get("tag")
    subject, why = resolve_subject(doc.get("ownership"), doc.get("confirmed", False), doc.get("buyer"), doc.get("notes") or "", tag, date8)
    notes = [why]
    if tag not in TYPE_MAP:
        folder = f"{MANAGED_ROOT}/{UNPROCESSABLE}/無法分類"
        type_label = "未分類"
        notes.append(f"類型標籤 {tag or '(無)'} 無法對應類別")
    else:
        type_label, category = TYPE_MAP[tag]
        if category == "07_醫療" and subject != "per":
            category = "01_發票收據"
            notes.append("醫療單據但主體不是家庭個人,改放 01_發票收據")
        folder = f"{MANAGED_ROOT}/{SUBJECT_DIRS[subject]}/{year}/{category}"
    if date8 == "00000000":
        notes.append("單據日期讀不到")
    parts = [date8, type_label, short_counterparty(doc.get("vendor"))]
    amt = fmt_amount(doc.get("amount"))
    if amt is not None:
        parts.append(amt)
    parts.append(doc["id"])
    return f"{folder}/{'_'.join(parts)}.{doc['ext']}", ";".join(notes)


# ---------------------------------------------------------------------------
# 計畫:既有文件遷移
# ---------------------------------------------------------------------------
def load_d1_snapshot(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    return data[0]["results"] if isinstance(data, list) else data["results"]


def plan_migration(args) -> None:
    docs = load_d1_snapshot(Path(args.d1_json))
    inv: dict[str, list[dict]] = defaultdict(list)
    for line in open(BACKFILL / "inv_all.jsonl"):
        x = json.loads(line)
        inv[x["sha"]].append(x)
    bodies = {}
    for p in (BACKFILL / "bodies").glob("*.json"):
        bodies[p.stem] = json.loads(p.read_text())  # key = sha256
    payload = {x["documentId"]: x for x in json.loads((EXTRACTION / "extraction-writeback-payload_20260926.json").read_text())}

    by_sha: dict[str, list[dict]] = defaultdict(list)
    for d in docs:
        if d.get("sha256"):
            by_sha[d["sha256"]].append(d)

    rows, missing, sql = [], [], []
    for sha, group in sorted(by_sha.items(), key=lambda kv: min(d["id"] for d in kv[1])):
        managed = [x for x in inv.get(sha, []) if x["rel"].startswith(MANAGED_ROOT + "/")]
        if len(managed) != 1:
            missing.extend((d["id"], d["status"], d["fname"], f"受管區內有 {len(managed)} 份相同 SHA-256") for d in group)
            continue
        src = managed[0]["rel"]
        canonical = sorted(group, key=lambda d: (d["status"] == "dup", d["id"]))[0]
        body = bodies.get(sha) or (payload.get(canonical["id"]) or {}).get("body") or {}
        tag = tag_from_notes(body.get("notes"))
        doc = {
            "id": canonical["id"],
            "ext": (src.rsplit(".", 1)[-1] if "." in src else "bin").lower(),
            "tag": tag,
            "ownership": canonical["ownership"],
            "confirmed": bool(canonical["oc"]),
            "buyer": canonical.get("buyer") or body.get("buyerTaxId"),
            "notes": body.get("notes") or "",
            "invoice_date": body.get("invoiceDate") or canonical.get("invoice_date"),
            "doc_date": canonical.get("doc_date"),
            "period": body.get("invoicePeriod") or canonical.get("period"),
            "vendor": body.get("vendorNameRaw") or canonical.get("vendor"),
            "amount": body.get("amountCents") if body.get("amountCents") is not None else canonical.get("amt"),
        }
        to, note = build_target(doc)
        exists = abs_path(src).is_file()
        size_ok = exists and abs_path(src).stat().st_size == managed[0]["size"]
        if not exists or not size_ok:
            note += ";⚠ 計畫當下 NAS 上找不到檔案或大小不符"
        for d in group:
            shared = "" if d is canonical else f"與 {canonical['id']} 同一個檔案({d['status']})"
            rows.append({
                "doc_id": d["id"], "from": src, "to": to, "sha256": sha,
                "subject": to.split("/")[1], "year": to.split("/")[2] if to.split("/")[1] != UNPROCESSABLE else "",
                "category": to.split("/")[3] if to.split("/")[1] != UNPROCESSABLE else to.split("/")[2],
                "tag": tag or "", "note": ";".join(x for x in (note, shared) if x),
            })
            sql.append(
                "UPDATE document_files SET storage = 'local', local_path = '{}' WHERE document_id = '{}' AND kind = 'original' AND is_current = 1 AND sha256 = '{}';".format(
                    src.replace("'", "''"), d["id"], sha
                )
            )
    for d in docs:
        if not d.get("sha256"):
            missing.append((d["id"], d["status"], d["fname"], "D1 沒有 sha256(早期測試上傳,可能只在 R2)"))

    tag = now_tag()
    OUT.mkdir(parents=True, exist_ok=True)
    plan_path = OUT / f"archive-plan-{tag}.tsv"
    write_plan(plan_path, rows)
    sql_path = OUT / f"migrate-local-paths-{tag}.sql"
    sql_path.write_text(
        "-- archive.py {} 產生:既有文件補 storage='local'、local_path=目前 NAS 位置(第五節步驟 1)。\n"
        "-- 條件含 sha256,sha256 不符的列不會被改。共 {} 句。\n{}\n".format(VERSION, len(sql), "\n".join(sql))
    )
    miss_path = OUT / f"archive-missing-{tag}.tsv"
    with open(miss_path, "w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["doc_id", "status", "original_file_name", "reason"])
        w.writerows(missing)
    summarize(plan_path, rows)
    print(f"SQL:{sql_path}({len(sql)} 句)")
    print(f"NAS 找不到/無法對應:{miss_path}({len(missing)} 份)")


# ---------------------------------------------------------------------------
# 計畫:已覆核新文件(API)
# ---------------------------------------------------------------------------
def plan_api(args) -> None:
    client = ApiClient()
    rows, after = [], ""
    while True:
        res = client.get(f"/archive/documents?after={after}&limit=500")
        for d in res["documents"]:
            lp = d.get("localPath") or ""
            if d["status"] != "archived" or not lp.startswith(f"{MANAGED_ROOT}/00_收件/"):
                continue
            doc = {
                "id": d["documentId"], "ext": lp.rsplit(".", 1)[-1].lower() if "." in lp else "bin",
                "tag": d.get("financeDocType"), "ownership": d["ownership"], "confirmed": bool(d["ownershipConfirmed"]),
                "buyer": d.get("buyerTaxId"), "notes": "", "invoice_date": d.get("invoiceDate"), "doc_date": d.get("docDate"),
                "period": d.get("invoicePeriod"), "vendor": d.get("vendorNameRaw"), "amount": d.get("amountCents"),
            }
            if d.get("entityId") in ("ap", "studio") and doc["ownership"] == "corp":
                doc["buyer"] = next(k for k, v in ENTITY_TAX_IDS.items() if v == d["entityId"])
            to, note = build_target(doc)
            parts = to.split("/")
            rows.append({"doc_id": d["documentId"], "from": lp, "to": to, "sha256": d["sha256"], "subject": parts[1],
                         "year": parts[2] if parts[1] != UNPROCESSABLE else "", "category": parts[-2], "tag": doc["tag"] or "", "note": note})
        after = res.get("next")
        if not after:
            break
    plan_path = OUT / f"archive-plan-{now_tag()}.tsv"
    OUT.mkdir(parents=True, exist_ok=True)
    write_plan(plan_path, rows)
    summarize(plan_path, rows)


PLAN_FIELDS = ["doc_id", "from", "to", "sha256", "subject", "year", "category", "tag", "note"]


def write_plan(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=PLAN_FIELDS, delimiter="\t", extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def read_plan(path: Path) -> list[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def summarize(path: Path, rows: list[dict]) -> None:
    from collections import Counter

    print(f"計畫:{path}({len(rows)} 筆,{len({r['from'] for r in rows})} 個檔案)")
    for k, v in sorted(Counter(r["subject"] for r in rows).items()):
        print(f"  {k}\t{v}")
    print("  類別:" + "、".join(f"{k} {v}" for k, v in sorted(Counter(r["category"] for r in rows).items())))
    warn = [r for r in rows if "⚠" in r["note"] or "讀不到" in r["note"]]
    if warn:
        print(f"  需注意:{len(warn)} 筆(備註含 ⚠ 或日期讀不到)")
    print("確認後執行:python3 archive.py --apply " + str(path))


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status: int | None, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


class ApiClient:
    def __init__(self):
        env = {}
        for line in CF_ENV.read_text().splitlines():
            m = re.match(r"^\s*(?:export\s+)?(\w+)=(.*)$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("'\"")
        self.headers = {
            "CF-Access-Client-Id": env["CF_ACCESS_CLIENT_ID"],
            "CF-Access-Client-Secret": env["CF_ACCESS_CLIENT_SECRET"],
            "X-Extraction-Writeback-Token": WB_TOKEN_FILE.read_text().split()[0],
            "Content-Type": "application/json",
        }

    def _req(self, method: str, path: str, body=None):
        req = urllib.request.Request(API_BASE + path, method=method, headers=self.headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode(errors="replace"))
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ApiError(None, str(e))

    def get(self, path: str):
        return self._req("GET", path)

    def post(self, path: str, body):
        return self._req("POST", path, body)


# ---------------------------------------------------------------------------
# 執行
# ---------------------------------------------------------------------------
STATE = OUT / "archive-state.json"


def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(**kw) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(kw, ensure_ascii=False, indent=2))


def done_ids(plan_name: str) -> set[str]:
    """這個計畫已完成的 DOC id(done 檔第 6 欄是計畫檔名;回滾計畫是另一個檔名,不會被原計畫擋掉)。"""
    ids = set()
    for p in OUT.glob("archive-done-*.tsv"):
        for r in csv.reader(open(p), delimiter="\t"):
            if len(r) >= 6 and r[0].startswith("DOC-") and r[5] == plan_name:
                ids.add(r[0])
    return ids


def moves_today() -> int:
    p = OUT / f"archive-done-{today()}.tsv"
    return sum(1 for r in csv.reader(open(p), delimiter="\t") if r and r[0].startswith("DOC-")) if p.exists() else 0


def move_file(src_rel: str, dst_rel: str, sha: str) -> None:
    src, dst = abs_path(src_rel), abs_path(dst_rel)
    if dst.exists():
        raise RuntimeError(f"目的地已有檔案:{dst_rel}")
    if sha256_file(src) != sha:
        raise RuntimeError(f"搬移前 SHA-256 不符:{src_rel}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.rename(src, dst)  # 同一個 SMB share 內,伺服器端 rename,不複製
    if sha256_file(dst) != sha:
        os.rename(dst, src)
        raise RuntimeError(f"搬移後 SHA-256 不符,已搬回:{dst_rel}")


def undo_files(moved: list[tuple[str, str, str]], log) -> list[str]:
    """把這批已搬的檔案搬回原位。回傳搬不回去的清單。"""
    stuck = []
    for src_rel, dst_rel, sha in reversed(moved):
        try:
            move_file(dst_rel, src_rel, sha)
            log(f"UNDO {dst_rel} -> {src_rel}")
        except Exception as e:  # noqa: BLE001
            stuck.append(f"{dst_rel} -> {src_rel}:{e}")
            log(f"UNDO_FAIL {dst_rel} -> {src_rel}:{e}")
    return stuck


def reconcile(client: ApiClient, batch: list[dict], moved: list[tuple[str, str, str]], log) -> str:
    """回寫回應不明時,以線上 local_path 為準。回傳 'committed' | 'reverted' | 'uncertain'。"""
    try:
        res = client.get("/archive/documents?ids=" + ",".join(r["doc_id"] for r in batch))
    except ApiError as e:
        log(f"RECONCILE_FAIL 無法查詢線上狀態:{e}")
        return "uncertain"
    online = {d["documentId"]: d.get("localPath") for d in res["documents"]}
    if all(online.get(r["doc_id"]) == r["to"] for r in batch):
        return "committed"
    if all(online.get(r["doc_id"]) == r["from"] for r in batch):
        stuck = undo_files(moved, log)
        return "reverted" if not stuck else "uncertain"
    log("RECONCILE_MIXED 線上狀態與這批不一致:" + json.dumps(online, ensure_ascii=False))
    return "uncertain"


def apply_plan(plan_path: Path, max_writes: int, log) -> int:
    rows = read_plan(plan_path)
    done = done_ids(plan_path.name)
    pending = [r for r in rows if r["doc_id"] not in done]
    if not pending:
        log("計畫內的文件都已完成。")
        save_state(plan=str(plan_path), status="done", at=now_tag())
        return 0
    budget = max_writes - moves_today()
    if budget <= 0:
        log(f"今天已搬 {moves_today()} 筆,達到 --max-writes {max_writes},明天用 --resume 接續。")
        save_state(plan=str(plan_path), status="daily_limit", at=now_tag())
        return 0

    # 同一個檔案的多筆(dup 文件)必須同一批;以檔案為單位分批。
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in pending:
        groups[r["from"]].append(r)
    batches, cur = [], []
    for g in groups.values():
        if cur and len(cur) + len(g) > BATCH_SIZE:
            batches.append(cur)
            cur = []
        cur.extend(g)
    if cur:
        batches.append(cur)

    client = ApiClient()
    tag = now_tag()
    done_path = OUT / f"archive-done-{today()}.tsv"
    rb_tsv = OUT / f"ROLLBACK-{tag}.tsv"
    rb_sh = OUT / f"ROLLBACK-{tag}.sh"
    written = 0
    for batch in batches:
        if written + len(batch) > budget:
            log(f"達到今日上限(--max-writes {max_writes}),已完成 {written} 筆。明天用 --resume 接續。")
            save_state(plan=str(plan_path), status="daily_limit", at=now_tag())
            return 0
        moved: list[tuple[str, str, str]] = []
        seen = set()
        try:
            for r in batch:
                if r["from"] in seen:
                    continue
                seen.add(r["from"])
                if r["from"] == r["to"]:
                    continue
                move_file(r["from"], r["to"], r["sha256"])
                moved.append((r["from"], r["to"], r["sha256"]))
        except Exception as e:  # noqa: BLE001
            log(f"MOVE_FAIL {e};把這批已搬的檔案搬回原位")
            stuck = undo_files(moved, log)
            save_state(plan=str(plan_path), status="move_failed" if not stuck else "uncertain", stuck=stuck, at=now_tag())
            return 1

        body = {"moves": [{"documentId": r["doc_id"], "fromPath": r["from"], "toPath": r["to"], "sha256": r["sha256"]} for r in batch]}
        outcome = "committed"
        try:
            client.post("/archive/moves", body)
        except ApiError as e:
            if e.status is None or e.status >= 500 and e.status != 503:
                log(f"WRITEBACK_UNCLEAR {e};以線上紀錄對帳")
                outcome = reconcile(client, batch, moved, log)
            else:
                log(f"WRITEBACK_FAIL {e};把這批已搬的檔案搬回原位")
                stuck = undo_files(moved, log)
                outcome = "reverted" if not stuck else "uncertain"
                if e.status == 409:
                    rej = OUT / f"archive-rejected-{tag}.json"
                    rej.write_text(e.body)
                    log(f"這批被拒絕(紀錄與計畫不符),明細:{rej}。請重新產生計畫。")
            if outcome != "committed":
                status = {"reverted": "stopped_writeback_failed", "uncertain": "uncertain"}[outcome]
                save_state(plan=str(plan_path), status=status, batch=[r["doc_id"] for r in batch],
                           moved=moved if outcome == "uncertain" else [], at=now_tag())
                log("已停止。D1 額度用完時,明天用 --resume 接續。" if e.status == 503 else "已停止,請檢查上面的錯誤。")
                return 1

        with open(done_path, "a", newline="") as f:
            w = csv.writer(f, delimiter="\t")
            for r in batch:
                w.writerow([r["doc_id"], r["from"], r["to"], r["sha256"], now_tag(), plan_path.name])
        new_rb = not rb_tsv.exists()
        with open(rb_tsv, "a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=PLAN_FIELDS, delimiter="\t", extrasaction="ignore")
            if new_rb:
                w.writeheader()
            for r in batch:
                w.writerow({**r, "from": r["to"], "to": r["from"], "note": f"回滾 {plan_path.name}"})
        if new_rb:
            rb_sh.write_text(
                "#!/bin/bash\n# 回滾 {} 在 {} 的搬移:檔案搬回原位並同步回寫線上路徑(同樣走 archive.py 的安全流程)。\n"
                "# 回滾本身也會產生新的 done/ROLLBACK 紀錄。\nset -e\n"
                'python3 "{}" --apply "{}" --max-writes 100000\n'.format(plan_path.name, tag, Path(__file__).resolve(), rb_tsv)
            )
            rb_sh.chmod(0o755)
        written += len(batch)
        log(f"OK 一批 {len(batch)} 筆(累計 {written});第一筆 {batch[0]['doc_id']} -> {batch[0]['to']}")
        time.sleep(0.3)

    log(f"完成:本次 {written} 筆。回滾腳本:{rb_sh}")
    save_state(plan=str(plan_path), status="done" if {r["doc_id"] for r in rows} <= done_ids(plan_path.name) else "partial", at=now_tag())
    return 0


def resume(max_writes: int, log) -> int:
    st = load_state()
    if not st.get("plan"):
        log("沒有可接續的狀態(archive-state.json)。")
        return 1
    if st.get("status") == "uncertain":
        log("上次停在不確定狀態,先對帳……")
        client = ApiClient()
        rows = [r for r in read_plan(Path(st["plan"])) if r["doc_id"] in set(st.get("batch", []))]
        moved = [tuple(m) for m in st.get("moved", [])]
        outcome = reconcile(client, rows, moved, log)
        if outcome == "uncertain":
            log("仍無法確定,請人工檢查 archive-state.json 列出的檔案與線上紀錄。")
            return 1
        if outcome == "committed":
            with open(OUT / f"archive-done-{today()}.tsv", "a", newline="") as f:
                w = csv.writer(f, delimiter="\t")
                for r in rows:
                    w.writerow([r["doc_id"], r["from"], r["to"], r["sha256"], now_tag(), Path(st["plan"]).name])
        log(f"對帳結果:{outcome}")
    return apply_plan(Path(st["plan"]), max_writes, log)


def main() -> int:
    ap = argparse.ArgumentParser(description="paraacco NAS 原始檔歸檔(先出計畫,確認後 --apply)")
    ap.add_argument("--source", choices=["migration", "api"], help="產生計畫的來源")
    ap.add_argument("--d1-json", help="--source migration 用的 D1 唯讀快照(wrangler d1 execute --json 輸出)")
    ap.add_argument("--apply", metavar="PLAN_TSV", help="執行已確認的計畫")
    ap.add_argument("--resume", action="store_true", help="接續上次(D1 額度用完、中斷)")
    ap.add_argument("--max-writes", type=int, default=800, help="每天最多搬幾份(預設 800)")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    log_path = OUT / f"archive-{today()}.log"

    def log(msg: str) -> None:
        line = f"{dt.datetime.now(TZ).strftime('%H:%M:%S')} {msg}"
        print(line)
        with open(log_path, "a") as f:
            f.write(line + "\n")

    if args.apply:
        if not MOUNT.is_dir():
            log(f"ABORT NAS 未掛載:{MOUNT}")
            return 1
        log(f"START {VERSION} apply {args.apply} max_writes={args.max_writes}")
        return apply_plan(Path(args.apply), args.max_writes, log)
    if args.resume:
        log(f"START {VERSION} resume max_writes={args.max_writes}")
        return resume(args.max_writes, log)
    if args.source == "migration":
        if not args.d1_json:
            ap.error("--source migration 需要 --d1-json")
        plan_migration(args)
        return 0
    if args.source == "api":
        plan_api(args)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
