#!/usr/bin/env python3
# paraacco NAS 原始檔歸檔 archive.py V1.03(2026-09-29)
# V1.03:CODE_TASK_vendor-name-from-taxid_20260929.md——檔名「對象」一律用供應商主檔名稱(vendors.name,由賣方統編對應),
#        不再用 OCR 店名;--source api 沒有 vendorId 的文件不歸檔、不改名,寫進 vendor-pending_*.tsv。
#        新增 --source audit:回溯檢查已歸檔檔名(rename-plan / vendor-pending / no-taxid 三份清單 + vendor-link SQL),
#        只列不動;rename-plan 與一般計畫同格式,Theo 確認後用 --apply 執行。V1.02 唯讀保留(archive_V1.02.py)。
#        另新增 --source attachments(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.3、2.4):物件的附件
#        (出貨單/收據/說明書…與影片/照片)改名成 <主文件檔名去副檔名>_附件_<類型>_<序號>.<ext>,放主文件同一資料夾;
#        主文件換人後重跑就會產生跟著改名的計畫。影片/照片列的 doc_id 是 ATT-<id>,--apply 走 /api/archive/attachment-moves。
# V1.02:CODE_TASK V1.04——信用卡帳單與銀行對帳單不分年份一律 80_共用未分流/<年>/04_對帳單(拿掉「2026-09 前」限制);
#        薪資轉帳(WPL/員工薪資)→ 該主體 05_薪資;國民年金依線上 ownership(corp → 10、per → 30)。V1.01 唯讀保留。
# V1.01:CODE_TASK V1.02/V1.03 裁示——勞健保類(勞保/健保/勞退/國民年金/相關催繳與行政執行)改放 05_薪資,
#        03_稅費規費只放稅、規費、罰單、牌照稅;歸屬原則(證券對帳單移出系統、銀行對帳單 80、勞健保看投保單位、
#        票面買方 83018456 → 10、其餘依 ownership,看不出用途的先放 30);--decisions 讀 Theo 逐筆決定;
#        同檔案的早期網頁上傳(DOC-2026-000001–000022)跟著回填那份歸檔。V1.0 唯讀保留(archive_V1.0.py)。
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

VERSION = "V1.03"
HOME = Path.home()
MANAGED_ROOT = "Paraacco_公司財務系統"
MOUNT = Path(os.environ.get("MOUNT", "/Volumes/ATLPAR_Bookkeeper"))
OUT = Path(os.environ.get("OUT", HOME / "dev/_reports/paraacco/archive"))
API_BASE = os.environ.get("API_BASE", "https://acco-api.parallelserver.org/api")
CF_ENV = Path(os.environ.get("CF_ENV", HOME / ".config/paraacco-batch/batch_ingest.env"))
WB_TOKEN_FILE = Path(os.environ.get("WB_TOKEN_FILE", HOME / ".config/paraacco-batch/extraction_writeback.token"))
BACKFILL = HOME / "dev/_reports/paraacco/backfill-20260926"
EXTRACTION = HOME / "dev/_reports/paraacco/extraction-20260926"
VENDOR_PENDING_OUT = Path(os.environ.get("VENDOR_PENDING_OUT", HOME / "dev/_reports/paraacco/vendor-pending"))
BATCH_SIZE = min(int(os.environ.get("BATCH_SIZE", "50")), 50)  # API 上限 50
TZ = dt.timezone(dt.timedelta(hours=8))

ENTITY_TAX_IDS = {"83018456": "ap", "60277434": "studio"}
SUBJECT_DIRS = {"ap": "10_平行空間有限公司", "studio": "20_呂劭翊建築師事務所", "per": "30_家庭個人", "shared": "80_共用未分流"}
UNPROCESSABLE = "90_無法處理"
OUTSIDE_ROOT = "_系統外資料"
SECURITIES_DIR = f"{OUTSIDE_ROOT}/證券對帳單"
AP_TAX_ID = "83018456"
LABOR_KEYWORDS = ("健保", "健康保險", "勞保", "勞工保險", "就保", "職保", "勞退", "勞工退休", "國民年金", "保費計算", "投保單位")
UTILITY_KEYWORDS = ("瓦斯", "電力", "自來水")
EARLY_UPLOAD_MAX = 22  # DOC-2026-000001–000022:9 月初網頁上傳,與回填同檔時跟著回填那份

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
    "GOV": ("稅費", "03_稅費規費"),  # 勞健保類在 build_target 改成 ("勞健保", "05_薪資")
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
    if not (rel.startswith(MANAGED_ROOT + "/") or rel.startswith(OUTSIDE_ROOT + "/")) or ".." in rel.split("/"):
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


# ---------------------------------------------------------------------------
# 賣方統編(V1.03)——規則同 @paraacco/domain 的 resolveVendorTaxId():QR > 印字,檢查碼,不一致以 QR 為準。
# ---------------------------------------------------------------------------
TAX_WEIGHTS = (1, 2, 1, 2, 1, 2, 4, 1)
TAX_SOURCE_LABELS = {"qr": "QR", "printed": "印字", "unreadable": "無法辨識"}


def normalize_tax_id(v) -> str:
    return re.sub(r"[\s-]", "", str(v or "")).strip()


def is_valid_tax_id(v) -> bool:
    t = normalize_tax_id(v)
    if not re.fullmatch(r"\d{8}", t):
        return False
    z = 0
    for i, w in enumerate(TAX_WEIGHTS):
        p = int(t[i]) * w
        z += p // 10 + p % 10
    return z % 5 == 0 or (t[6] == "7" and (z + 1) % 5 == 0)


def resolve_tax_id(qr=None, printed=None, legacy=None, legacy_source=None) -> dict:
    qr, printed, legacy = normalize_tax_id(qr), normalize_tax_id(printed), normalize_tax_id(legacy)
    if qr and is_valid_tax_id(qr):
        note = f"賣方統編 QR({qr})與印字({printed})不一致,以 QR 為準" if printed and printed != qr else ""
        return {"tax_id": qr, "source": "qr", "raw": "", "note": note}
    if printed and is_valid_tax_id(printed):
        return {"tax_id": printed, "source": "printed", "raw": "", "note": f"QR 賣方統編 {qr} 檢查碼錯誤,改用印字" if qr else ""}
    if not qr and not printed and legacy and is_valid_tax_id(legacy):
        return {"tax_id": legacy, "source": legacy_source if legacy_source in ("qr", "printed") else "printed", "raw": "", "note": ""}
    raw = qr or printed or legacy
    return {"tax_id": "", "source": "unreadable", "raw": raw, "note": f"賣方統編 {raw} 檢查碼錯誤" if raw else "讀不到賣方統編"}


def filename_counterparty(local_path: str) -> str | None:
    """YYYYMMDD_類型_對象[_金額]_DOC-….ext 的「對象」段;不是這個格式回 None。"""
    stem = local_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    parts = stem.split("_")
    if len(parts) < 4 or not parts[-1].startswith("DOC-") or not re.fullmatch(r"\d{8}", parts[0]):
        return None
    return parts[2]


def replace_counterparty(local_path: str, new_seg: str) -> str:
    folder, name = local_path.rsplit("/", 1)
    stem, ext = name.rsplit(".", 1) if "." in name else (name, "")
    parts = stem.split("_")
    parts[2] = new_seg
    return f"{folder}/{'_'.join(parts)}" + (f".{ext}" if ext else "")


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


def is_labor(tag: str | None, notes: str) -> bool:
    return tag in ("GOV", "SAL", "INS", None) and any(k in notes for k in LABOR_KEYWORDS)


def is_salary_transfer(doc: dict) -> bool:
    src = doc.get("src") or ""
    name = src.rsplit("/", 1)[-1]
    return "員工薪資" in src or "_WPL_" in name or name.startswith("WPL")


def subject_by_ownership(ownership: str | None, buyer: str | None) -> str:
    if buyer == AP_TAX_ID or ownership == "corp":
        return "ap"
    return "per" if ownership == "per" else "shared"


def decision_subject(decision: str | None) -> str | None:
    """Theo 逐筆決定(ownership-decision_*.csv 的 decision 欄)→ 主體 key / 'out' / None。"""
    d = (decision or "").strip()
    for prefix, key in (("10_", "ap"), ("20_", "studio"), ("30_", "per"), ("80_", "shared")):
        if d.startswith(prefix):
            return key
    if d.startswith("移出系統"):
        return "out"
    return None


def resolve_subject(doc: dict, tag: str | None, date8: str) -> tuple[str, str]:
    """歸屬原則(CODE_TASK V1.03 第一節)。回傳 (主體 key 或 'out', 判斷依據)。順序:
    證券對帳單 → 移出;薪資轉帳 → 該主體 05_薪資;信用卡帳單/銀行對帳單 → 80(不分年份);勞健保 → 看投保單位(國民年金依線上 ownership);
    票面買方 83018456 → 10;其餘依 ownership(corp → 10,只有勞健保掛事務所);看不出來 → 30。"""
    notes = f"{doc.get('notes') or ''} {doc.get('vendor') or ''}"
    ownership, confirmed, buyer = doc.get("ownership"), doc.get("confirmed", False), doc.get("buyer")
    if tag == "SEC":
        return "out", "證券對帳單移出系統(改由投資 app 彙整)"
    if is_salary_transfer(doc):
        return subject_by_ownership(ownership, buyer), "薪資轉帳(WPL/員工薪資)"
    if tag in ("CCS", "BNK"):
        return "shared", "信用卡帳單/銀行對帳單:共用(80,不分年份)"
    if is_labor(tag, notes):
        if "國民年金" in notes:
            if confirmed and ownership == "corp":
                return "ap", "國民年金,依線上 ownership=corp"
            return "per", "國民年金,依線上 ownership(個人)"
        if "平行空間" in notes and "事務所" not in notes:
            return "ap", "勞健保,投保單位平行空間"
        if "事務所" in notes and "平行空間" not in notes:
            return "studio", "勞健保,投保單位事務所"
    decided = decision_subject(doc.get("decision"))
    if decided:
        return decided, "Theo 逐筆決定(ownership-decision_20260928_V1.02.csv)"
    if buyer == AP_TAX_ID or AP_TAX_ID in notes:
        return "ap", f"票面買方 {AP_TAX_ID}"
    if confirmed and ownership == "per":
        return "per", "ownership=per"
    if confirmed and ownership == "corp":
        if buyer == "60277434":
            return "ap", "⚠ 買方是事務所統編,但原則 1 只有勞健保掛事務所,先放 10,請確認"
        return "ap", "ownership=corp(非勞健保一律 10)"
    if is_labor(tag, notes):
        return "shared", "⚠ 勞健保但看不出投保單位"
    return "per", "歸屬未確認、看不出用途,依原則 3 先放 30"


def build_target(doc: dict) -> tuple[str, str]:
    """doc 需要:id, ext, tag, ownership, confirmed, buyer, notes, invoice_date, doc_date, period, vendor, amount,
    decision(選填), src(移出系統時保留原相對路徑)。回傳 (目的相對路徑, 備註)。"""
    date8, year = date_parts(doc.get("invoice_date"), doc.get("doc_date"), doc.get("period"))
    tag = doc.get("tag")
    subject, why = resolve_subject(doc, tag, date8)
    notes = [why]
    if subject == "out":
        return f"{SECURITIES_DIR}/{doc['src']}", ";".join(notes + ["線上標 ignored"])
    if tag not in TYPE_MAP:
        folder = f"{MANAGED_ROOT}/{UNPROCESSABLE}/無法分類"
        type_label = "未分類"
        notes.append(f"類型標籤 {tag or '(無)'} 無法對應類別")
    else:
        type_label, category = TYPE_MAP[tag]
        text = f"{doc.get('notes') or ''} {doc.get('vendor') or ''}"
        if is_salary_transfer(doc):
            type_label, category = "薪資轉帳", "05_薪資"
        elif is_labor(tag, text):
            type_label, category = "勞健保", "05_薪資"
        elif tag == "GOV" and any(k in (doc.get("vendor") or "") for k in UTILITY_KEYWORDS):
            type_label, category = "通知", "02_帳單繳費"  # 例:瓦斯安全檢查通知,不是稅費
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

    decisions = {}
    if args.decisions:
        decisions = {r["doc"]: r["decision"] for r in csv.DictReader(open(args.decisions, encoding="utf-8-sig"))}

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
        # 同一個檔案有多筆時:早期網頁上傳(000001–000022)跟著回填那份(CODE_TASK V1.02「另外處理」)。
        canonical = sorted(group, key=lambda d: (int(d["id"][-6:]) <= EARLY_UPLOAD_MAX, d["status"] == "dup", d["id"]))[0]
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
            "decision": decisions.get(canonical["id"]),
            "src": src,
        }
        to, note = build_target(doc)
        exists = abs_path(src).is_file()
        size_ok = exists and abs_path(src).stat().st_size == managed[0]["size"]
        if not exists or not size_ok:
            note += ";⚠ 計畫當下 NAS 上找不到檔案或大小不符"
        for d in group:
            shared = "" if d is canonical else f"與 {canonical['id']} 同一個檔案,跟著它歸檔(目前 status={d['status']})"
            parts = to.split("/")
            if parts[0] == OUTSIDE_ROOT:
                subject, year, category = OUTSIDE_ROOT, "", "證券對帳單"
            elif parts[1] == UNPROCESSABLE:
                subject, year, category = parts[1], "", parts[2]
            else:
                subject, year, category = parts[1], parts[2], parts[3]
            rows.append({
                "doc_id": d["id"], "from": src, "to": to, "sha256": sha,
                "subject": subject, "year": year, "category": category,
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
    rows, after, pending = [], "", []
    while True:
        res = client.get(f"/archive/documents?after={after}&limit=500")
        for d in res["documents"]:
            lp = d.get("localPath") or ""
            if d["status"] != "archived" or not lp.startswith(f"{MANAGED_ROOT}/00_收件/"):
                continue
            # V1.03 R-V3:供應商未建檔(沒有 vendorId)→ 不歸檔、不改名,列進 vendor-pending。
            if not d.get("vendorId"):
                pending.append(api_doc_to_audit(d))
                continue
            doc = {
                "id": d["documentId"], "ext": lp.rsplit(".", 1)[-1].lower() if "." in lp else "bin",
                "tag": d.get("financeDocType"), "ownership": d["ownership"], "confirmed": bool(d["ownershipConfirmed"]),
                "buyer": d.get("buyerTaxId"), "notes": " ".join(filter(None, [d.get("vendorNameRaw"), d.get("displayName")])), "src": lp, "invoice_date": d.get("invoiceDate"), "doc_date": d.get("docDate"),
                "period": d.get("invoicePeriod"), "vendor": d.get("vendorName"), "amount": d.get("amountCents"),
            }
            if d.get("entityId") in ("ap", "studio") and doc["ownership"] == "corp":
                doc["buyer"] = next(k for k, v in ENTITY_TAX_IDS.items() if v == d["entityId"])
            to, note = build_target(doc)
            parts = to.split("/")
            subject = OUTSIDE_ROOT if parts[0] == OUTSIDE_ROOT else parts[1]
            rows.append({"doc_id": d["documentId"], "from": lp, "to": to, "sha256": d["sha256"], "subject": subject,
                         "year": parts[2] if subject not in (UNPROCESSABLE, OUTSIDE_ROOT) else "", "category": parts[-2], "tag": doc["tag"] or "", "note": note})
        after = res.get("next")
        if not after:
            break
    tag = now_tag()
    plan_path = OUT / f"archive-plan-{tag}.tsv"
    OUT.mkdir(parents=True, exist_ok=True)
    write_plan(plan_path, rows)
    summarize(plan_path, rows)
    if pending:
        vp, nt = write_vendor_lists(pending, tag)
        print(f"供應商未建檔、這次不歸檔:{len(pending)} 份 → {vp}、{nt}")


# ---------------------------------------------------------------------------
# 回溯檢查(V1.03,CODE_TASK_vendor-name-from-taxid_20260929.md 第二節)——只列不動
# ---------------------------------------------------------------------------
FILED_RE = re.compile(rf"^{re.escape(MANAGED_ROOT)}/(10|20|30|80)_[^/]+/")
EXCLUDED_STATUSES = ("ignored", "dup")


def api_doc_to_audit(d: dict) -> dict:
    return {
        "id": d["documentId"], "status": d["status"], "vendor_id": d.get("vendorId"), "vendor_name": d.get("vendorName"),
        "vendor_status": d.get("vendorStatus"), "ocr_name": d.get("vendorNameRaw"),
        "date": d.get("invoiceDate") or d.get("docDate"), "amount": d.get("amountCents"),
        "local_path": d.get("localPath") or "", "sha256": d.get("sha256") or "",
        "tax": d.get("vendorTaxId"), "tax_qr": d.get("vendorTaxIdQr"), "tax_printed": d.get("vendorTaxIdPrinted"),
        "tax_src": d.get("vendorTaxIdSource"),
    }


def snapshot_doc_to_audit(r: dict) -> dict:
    return {
        "id": r["id"], "status": r["status"], "vendor_id": r.get("vendor_id"), "vendor_name": None, "vendor_status": r.get("vendor_status"),
        "ocr_name": r.get("vendor_name_raw"), "date": r.get("invoice_date") or r.get("doc_date"), "amount": r.get("amount_cents"),
        "local_path": r.get("local_path") or "", "sha256": r.get("sha256") or "",
        "tax": r.get("tax"), "tax_qr": r.get("tax_qr"), "tax_printed": r.get("tax_printed"), "tax_src": r.get("tax_src"),
    }


def nt_amount(cents) -> str:
    return "" if cents in (None, "") else fmt_amount(cents)


def write_vendor_lists(docs: list[dict], tag: str) -> tuple[Path, Path]:
    """vendor-pending(統編有效未建檔,依統編彙總)與 no-taxid(沒有有效賣方統編)。docs 需已帶 res(resolve_tax_id 結果)。"""
    VENDOR_PENDING_OUT.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[dict]] = defaultdict(list)
    no_tax = []
    for d in docs:
        d.setdefault("res", resolve_tax_id(d.get("tax_qr"), d.get("tax_printed"), d.get("tax"), d.get("tax_src")))
        (groups[d["res"]["tax_id"]] if d["res"]["tax_id"] else no_tax).append(d)
    vp = VENDOR_PENDING_OUT / f"vendor-pending_{tag}.tsv"
    with open(vp, "w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["賣方統編", "統編來源(QR/印字/無法辨識)", "OCR 原始店名(僅供參考)", "單據數", "DOC ID 清單", "日期範圍", "合計金額", "目前 NAS 路徑", "備註"])
        for tax_id, g in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            dates = sorted(d["date"] for d in g if d.get("date"))
            names = sorted({d["ocr_name"] for d in g if d.get("ocr_name")})
            srcs = sorted({TAX_SOURCE_LABELS[d["res"]["source"]] for d in g})
            notes = sorted({d["note"] for d in g if d.get("note")} | {d["res"]["note"] for d in g if d["res"]["note"]})
            total = sum(int(d["amount"]) for d in g if d.get("amount") not in (None, ""))
            w.writerow([tax_id, "/".join(srcs), "、".join(names), len(g), ",".join(sorted(d["id"] for d in g)),
                        f"{dates[0]}~{dates[-1]}" if dates else "", fmt_amount(total), " | ".join(sorted(d["local_path"] for d in g if d["local_path"])),
                        ";".join(notes)])
    nt = VENDOR_PENDING_OUT / f"no-taxid_{tag}.tsv"
    with open(nt, "w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["doc_id", "status", "統編狀況", "OCR 原始店名(僅供參考)", "日期", "金額", "目前 NAS 路徑", "備註"])
        for d in sorted(no_tax, key=lambda d: d["id"]):
            w.writerow([d["id"], d["status"], d["res"]["note"], d.get("ocr_name") or "", d.get("date") or "", nt_amount(d.get("amount")),
                        d["local_path"], d.get("note") or ""])
    return vp, nt


def load_rows(path: str) -> list[dict]:
    data = json.loads(Path(path).read_text())
    return data[0]["results"] if isinstance(data, list) else data.get("results", data)


def plan_audit(args) -> None:
    """已歸檔檔名的對象段 vs 主檔名稱。--d1-json(唯讀 SELECT 快照)+ --vendors-json;沒給就從 API 讀。"""
    if args.d1_json:
        if not args.vendors_json:
            raise SystemExit("--source audit --d1-json 需要一起給 --vendors-json")
        docs = [snapshot_doc_to_audit(r) for r in load_rows(args.d1_json)]
        vendor_rows = load_rows(args.vendors_json)
        by_tax = {normalize_tax_id(v["tax_id"]): v for v in vendor_rows if v.get("tax_id")}
        by_id = {v["id"]: v for v in vendor_rows}
    else:
        client, docs, after = ApiClient(), [], ""
        while True:
            res = client.get(f"/archive/documents?after={after}&limit=500")
            docs += [api_doc_to_audit(d) for d in res["documents"]]
            after = res.get("next")
            if not after:
                break
        by_tax, by_id = None, {}
    docs = [d for d in docs if d["status"] not in EXCLUDED_STATUSES and not d["local_path"].startswith(OUTSIDE_ROOT + "/")]

    rename, links, unmatched, old_rule, skipped = [], [], [], [], []
    for d in docs:
        d["res"] = resolve_tax_id(d.get("tax_qr"), d.get("tax_printed"), d.get("tax"), d.get("tax_src"))
        if by_tax is not None:
            v = by_tax.get(d["res"]["tax_id"]) if d["res"]["tax_id"] else None
            vendor_id, vendor_name = (v["id"], v["name"]) if v else (None, None)
        else:
            vendor_id, vendor_name = d.get("vendor_id"), d.get("vendor_name")
        if d.get("vendor_id") and d.get("vendor_id") != vendor_id:
            old = by_id.get(d["vendor_id"], {}).get("name", d["vendor_id"])
            d["note"] = f"線上 vendorId={d['vendor_id']}({old})是舊規則以名稱對應,統編{'未建檔' if d['res']['tax_id'] else '無法辨識'}"
            old_rule.append(d)
        if not vendor_id:
            unmatched.append(d)
            continue
        if d.get("vendor_id") != vendor_id:
            links.append((d["id"], vendor_id, vendor_name, d["res"]["tax_id"]))
        if not FILED_RE.match(d["local_path"]):
            continue  # 還在 00_收件(或 90_無法處理):歸檔時就會用主檔名稱,不用改名
        if "_附件_" in d["local_path"].rsplit("/", 1)[-1]:
            continue  # 物件附件跟著主文件命名(--source attachments),不用對象段
        seg = filename_counterparty(d["local_path"])
        want = short_counterparty(vendor_name)
        if seg is None:
            skipped.append((d["id"], d["local_path"], "檔名不是 YYYYMMDD_類型_對象_金額_DOC 格式"))
            continue
        if seg == want:
            continue
        to = replace_counterparty(d["local_path"], want)
        parts = to.split("/")
        rename.append({
            "doc_id": d["id"], "from": d["local_path"], "to": to, "sha256": d["sha256"], "subject": parts[1], "year": parts[2],
            "category": parts[3], "tag": "", "note": f"對象「{seg}」→ 主檔「{vendor_name}」(統編 {d['res']['tax_id']},來源 {TAX_SOURCE_LABELS[d['res']['source']]})",
        })

    tag = now_tag()
    VENDOR_PENDING_OUT.mkdir(parents=True, exist_ok=True)
    rp = VENDOR_PENDING_OUT / f"rename-plan_{tag}.tsv"
    write_plan(rp, rename)
    vp, nt = write_vendor_lists(unmatched, tag)
    sql_path = VENDOR_PENDING_OUT / f"vendor-link-updates_{tag}.sql"
    sql_path.write_text(
        "-- archive.py {} --source audit 產生:統編已建檔、線上 vendorId 還沒指到主檔的文件(D1 寫入,Theo 確認後才執行)。共 {} 句。\n{}\n".format(
            VERSION, len(links),
            "\n".join(
                "UPDATE documents SET vendor_id = '{}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = '{}'; -- {} {}".format(
                    vid.replace("'", "''"), doc_id, tax_id, name) for doc_id, vid, name, tax_id in links)))
    if old_rule:
        orp = VENDOR_PENDING_OUT / f"old-rule-vendor-matches_{tag}.tsv"
        with open(orp, "w", newline="") as f:
            w = csv.writer(f, delimiter="\t")
            w.writerow(["doc_id", "status", "線上 vendorId", "賣方統編", "OCR 店名", "NAS 路徑", "說明"])
            for d in old_rule:
                w.writerow([d["id"], d["status"], d["vendor_id"], d["res"]["tax_id"] or d["res"]["raw"], d.get("ocr_name") or "", d["local_path"], d["note"]])
        print(f"舊規則(名稱)對應、統編對不上主檔:{len(old_rule)} 份 → {orp}")
    if skipped:
        sp = VENDOR_PENDING_OUT / f"rename-skipped_{tag}.tsv"
        with open(sp, "w", newline="") as f:
            csv.writer(f, delimiter="\t").writerows([("doc_id", "local_path", "reason"), *skipped])
        print(f"檔名格式無法解析:{len(skipped)} 份 → {sp}")
    print(f"檢查 {len(docs)} 份(排除 ignored/dup、_系統外資料)")
    print(f"rename-plan:{rp}({len(rename)} 筆,確認後執行:python3 archive.py --apply {rp})")
    print(f"vendor-pending:{vp}({len({d['res']['tax_id'] for d in unmatched if d['res']['tax_id']})} 個統編)")
    print(f"no-taxid:{nt}({sum(1 for d in unmatched if not d['res']['tax_id'])} 份)")
    print(f"vendor-link SQL:{sql_path}({len(links)} 句)")


# ---------------------------------------------------------------------------
# 計畫:物件附件改名(V1.03)
# ---------------------------------------------------------------------------
ATTACHMENT_ROLE_LABELS = {"DEL": "出貨單", "RET": "收據", "ORD": "訂單", "SIGN": "簽單", "MAN": "說明書", "WAR": "保固單", "PHOTO": "照片", "OTHER": "其他"}
ATTACHMENT_KIND_LABELS = {"video": "影片", "photo": "照片", "other": "其他"}


def attachment_target(primary_path: str, label: str, seq: int, src_path: str) -> str:
    folder, name = primary_path.rsplit("/", 1)
    stem = name.rsplit(".", 1)[0]
    ext = src_path.rsplit(".", 1)[-1] if "." in src_path.rsplit("/", 1)[-1] else "bin"
    return f"{folder}/{stem}_附件_{label}_{seq:02d}.{ext}"


def plan_attachments(args) -> None:
    client = ApiClient()
    res = client.get("/archive/objects")
    by_obj: dict[str, list[dict]] = defaultdict(list)
    for l in res["links"]:
        by_obj[l["purchaseId"]].append(l)
    atts_by_obj: dict[str, list[dict]] = defaultdict(list)
    for a in res["attachments"]:
        atts_by_obj[a["purchaseId"]].append(a)
    rows, skipped = [], []
    for pid in sorted(set(by_obj) | set(atts_by_obj)):
        links = by_obj.get(pid, [])
        primary = next((l for l in links if l["relationKind"] == "primary"), None)
        if not primary or not primary.get("localPath"):
            skipped.append((pid, "", "物件沒有主文件或主文件沒有 NAS 路徑"))
            continue
        ppath = primary["localPath"]
        if not FILED_RE.match(ppath):
            skipped.append((pid, ppath, "主文件還沒歸檔(不在 10/20/30/80 正式位置),歸檔後再產生"))
            continue
        seq: dict[str, int] = defaultdict(int)
        items = [(l["documentId"], ATTACHMENT_ROLE_LABELS.get(l.get("attachmentRole") or "OTHER", "其他"), l.get("localPath"), l.get("sha256"), l.get("storage"))
                 for l in sorted(links, key=lambda x: x["documentId"]) if l["relationKind"] != "primary"]
        items += [(f"ATT-{a['id']}", ATTACHMENT_KIND_LABELS.get(a["kind"], "其他"), a["localPath"], a.get("sha256"), "local")
                  for a in sorted(atts_by_obj.get(pid, []), key=lambda x: x["id"])]
        for doc_id, label, src, sha, storage in items:
            seq[label] += 1
            if not src or storage != "local":
                skipped.append((doc_id, src or "", "原始檔不在 NAS(storage≠local)"))
                continue
            to = attachment_target(ppath, label, seq[label], src)
            if src == to:
                continue
            if not sha:
                try:
                    sha = sha256_file(abs_path(src))
                except (OSError, ValueError) as e:
                    skipped.append((doc_id, src, f"讀不到檔案算 SHA-256:{e}"))
                    continue
            parts = to.split("/")
            rows.append({"doc_id": doc_id, "from": src, "to": to, "sha256": sha, "subject": parts[1], "year": parts[2], "category": parts[3],
                         "tag": label, "note": f"物件 {pid} 附件;主文件 {primary['documentId']}"})
    tag = now_tag()
    OUT.mkdir(parents=True, exist_ok=True)
    plan_path = OUT / f"attachment-plan-{tag}.tsv"
    write_plan(plan_path, rows)
    summarize(plan_path, rows)
    if skipped:
        sp = OUT / f"attachment-skipped-{tag}.tsv"
        with open(sp, "w", newline="") as f:
            csv.writer(f, delimiter="\t").writerows([("id", "local_path", "reason"), *skipped])
        print(f"略過 {len(skipped)} 筆 → {sp}")


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
            # Cloudflare 會用 error code 1010 擋 Python urllib 預設的 User-Agent,明確帶一個。
            "User-Agent": f"paraacco-archive/{VERSION} (+curl-compatible)",
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
            if len(r) >= 6 and (r[0].startswith("DOC-") or r[0].startswith("ATT-")) and r[5] == plan_name:
                ids.add(r[0])
    return ids


def moves_today() -> int:
    p = OUT / f"archive-done-{today()}.tsv"
    return sum(1 for r in csv.reader(open(p), delimiter="\t") if r and (r[0].startswith("DOC-") or r[0].startswith("ATT-"))) if p.exists() else 0


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


def is_att(r: dict) -> bool:
    return r["doc_id"].startswith("ATT-")


def reconcile(client: ApiClient, batch: list[dict], moved: list[tuple[str, str, str]], log) -> str:
    """回寫回應不明時,以線上 local_path 為準。回傳 'committed' | 'reverted' | 'uncertain'。"""
    try:
        if is_att(batch[0]):
            res = client.get("/archive/objects")
            online = {f"ATT-{a['id']}": a.get("localPath") for a in res["attachments"]}
        else:
            res = client.get("/archive/documents?ids=" + ",".join(r["doc_id"] for r in batch))
            online = {d["documentId"]: d.get("localPath") for d in res["documents"]}
    except ApiError as e:
        log(f"RECONCILE_FAIL 無法查詢線上狀態:{e}")
        return "uncertain"
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

    # 同一個檔案的多筆(dup 文件)必須同一批;以檔案為單位分批。V1.03:物件附件(ATT-*)跟文件分開成批,各走各的回寫端點。
    batches = []
    for kind_rows in ([r for r in pending if not is_att(r)], [r for r in pending if is_att(r)]):
        groups: dict[str, list[dict]] = defaultdict(list)
        for r in kind_rows:
            groups[r["from"]].append(r)
        cur: list[dict] = []
        for g in groups.values():
            if cur and len(cur) + len(g) > BATCH_SIZE:
                batches.append(cur)
                cur = []
            cur.extend(g)
        if cur:
            batches.append(cur)

    client = ApiClient()
    tag = f"{now_tag()}-{os.getpid()}"  # 同一秒內連續執行(例如回滾)不會共用同一個 ROLLBACK 檔
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

        if is_att(batch[0]):
            endpoint = "/archive/attachment-moves"
            body = {"moves": [{"attachmentId": int(r["doc_id"][4:]), "fromPath": r["from"], "toPath": r["to"], "sha256": r["sha256"]} for r in batch]}
        else:
            endpoint = "/archive/moves"
            body = {"moves": [{"documentId": r["doc_id"], "fromPath": r["from"], "toPath": r["to"], "sha256": r["sha256"]} for r in batch]}
        outcome = "committed"
        try:
            client.post(endpoint, body)
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
    ap.add_argument("--source", choices=["migration", "api", "audit", "attachments"],
                    help="產生計畫的來源;audit = 回溯檢查檔名對象(只列不動);attachments = 物件附件改名計畫")
    ap.add_argument("--d1-json", help="--source migration/audit 用的 D1 唯讀快照(wrangler d1 execute --json 輸出)")
    ap.add_argument("--vendors-json", help="--source audit --d1-json 時的供應商主檔快照(SELECT id, name, tax_id FROM vendors)")
    ap.add_argument("--decisions", help="Theo 逐筆歸屬決定 CSV(doc, decision 欄),例:ownership-decision_20260928_V1.02.csv")
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
    if args.source == "audit":
        plan_audit(args)
        return 0
    if args.source == "attachments":
        plan_attachments(args)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
