#!/bin/bash
# paraacco 每日批次進件 V1.0(2026-09-22)
# Bookkeeper_Scanner → POST acco-api /api/batch-import/documents → 複製到 00_原始文件/<日期>/
#
# 驗證三層:Cloudflare Access Service Token(邊緣)→ access-jwt.ts 白名單 → X-Local-Scanner-Token
#
# 環境變數(皆可選):
#   DRY_RUN=1        只列出會上傳的檔案,不上傳、不複製、不寫 manifest
#   LIMIT=N          本次最多處理 N 個新檔案(0 = 不限)
#   DELETE_SOURCE=1  上傳成功且複製檔 sha256 驗證一致後,刪除原始檔(預設 0 = 不刪)
# 路徑皆可用同名環境變數覆寫(測試用)。bash 3.2 相容(macOS 內建 /bin/bash)。
VERSION="V1.0"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

SRC="${SRC:-/Volumes/Scanner/Bookkeeper_Scanner}"
DEST_ROOT="${DEST_ROOT:-/Volumes/ATLPAR_Bookkeeper/Paraacco_公司財務系統/00_原始文件}"
REPO="${REPO:-$HOME/dev/paraacco}"
TOKEN_FILE="${TOKEN_FILE:-$REPO/.local-scanner-token}"
CF_ENV="${CF_ENV:-$HOME/.config/paraacco-batch/batch_ingest.env}"
MANIFEST="${MANIFEST:-$REPO/.batch-import-manifest.log}"
LOG_DIR="${LOG_DIR:-$REPO/logs}"
API="${API:-https://acco-api.parallelserver.org/api/batch-import/documents}"
LOCK="${LOCK:-/tmp/paraacco-batch-ingest.lock}"
DRY_RUN="${DRY_RUN:-0}"; LIMIT="${LIMIT:-0}"; DELETE_SOURCE="${DELETE_SOURCE:-0}"

TODAY=$(date +%Y%m%d)
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/batch-ingest-$TODAY.log"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }
if [ "$(uname)" = "Darwin" ]; then
  mtime() { stat -f %m "$1"; }
else
  mtime() { stat -c %Y "$1"; }
fi
if command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  sha() { sha256sum "$1" | awk '{print $1}'; }
fi

if ! mkdir "$LOCK" 2>/dev/null; then log "SKIP 另一個執行中($LOCK)"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rmdir "$LOCK" 2>/dev/null' EXIT

log "START $VERSION dry_run=$DRY_RUN limit=$LIMIT delete_source=$DELETE_SOURCE"
[ -f "$TOKEN_FILE" ] || { log "ABORT MISSING_TOKEN_FILE $TOKEN_FILE"; exit 1; }
[ -f "$CF_ENV" ]     || { log "ABORT MISSING_CF_ENV $CF_ENV"; exit 1; }
[ -d "$SRC" ]        || { log "ABORT 來源無法存取(未掛載、不存在或無權限): $SRC"; exit 1; }
[ -d "$DEST_ROOT" ]  || { log "ABORT 目的地無法存取(未掛載、不存在或無權限): $DEST_ROOT"; exit 1; }

. "$CF_ENV"
if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
  log "ABORT CF_ENV 缺少 CF_ACCESS_CLIENT_ID 或 CF_ACCESS_CLIENT_SECRET"; exit 1
fi
SCANNER_TOKEN=$(cat "$TOKEN_FILE")
touch "$MANIFEST"

up=0; skip=0; fail=0; wait=0; n=0
find "$SRC" -type f \( -iname '*.pdf' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) ! -name '.*' -print0 > "$TMP/list"
while IFS= read -r -d '' f; do
  if [ "$LIMIT" -gt 0 ] && [ "$n" -ge "$LIMIT" ]; then break; fi
  mt=$(mtime "$f" 2>/dev/null)
  case "$mt" in ''|*[!0-9]*) fail=$((fail+1)); log "FAIL 無法取得修改時間: $f"; continue;; esac
  age=$(( $(date +%s) - mt ))
  if [ "$age" -lt 120 ]; then wait=$((wait+1)); log "WAIT 剛寫入 ${age}s,下次處理: $f"; continue; fi
  h=$(sha "$f" 2>/dev/null)
  case "$h" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) fail=$((fail+1)); log "FAIL 無法計算 sha256: $f"; continue;; esac
  if cut -f1 "$MANIFEST" | grep -qx "$h" || grep -qx "$h" "$TMP/seen" 2>/dev/null; then skip=$((skip+1)); continue; fi
  echo "$h" >> "$TMP/seen"
  n=$((n+1))
  if [ "$DRY_RUN" = "1" ]; then log "DRY 會上傳: $f"; continue; fi

  code=$(curl -s -o "$TMP/resp" -w '%{http_code}' --max-time 180 -X POST "$API" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H "X-Local-Scanner-Token: $SCANNER_TOKEN" \
    -F "file=@$f")
  if [ "$code" != "201" ]; then
    fail=$((fail+1)); log "FAIL http=$code $f :: $(head -c 200 "$TMP/resp" 2>/dev/null | tr '\n' ' ')"; continue
  fi
  id=$(grep -oE '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMP/resp" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
  [ -n "$id" ] || id="(無id)"
  printf '%s\t%s\t%s\t%s\n' "$h" "$id" "$(date '+%Y-%m-%dT%H:%M:%S')" "$f" >> "$MANIFEST"
  up=$((up+1))

  d="$DEST_ROOT/$TODAY"; mkdir -p "$d"
  b=$(basename "$f"); t="$d/$b"
  if [ -e "$t" ]; then t="$d/${b%.*}_${h:0:8}.${b##*.}"; fi
  if cp -p "$f" "$t" && [ "$(sha "$t")" = "$h" ]; then
    log "OK $id $f -> $t"
    if [ "$DELETE_SOURCE" = "1" ]; then rm -f "$f" && log "DEL 已刪除原始檔: $f"; fi
  else
    log "WARN 已上傳 $id,但複製/驗證失敗,原始檔保留: $f"
  fi
done < "$TMP/list"

log "END uploaded=$up skipped=$skip waiting=$wait failed=$fail"
[ "$fail" -eq 0 ]
