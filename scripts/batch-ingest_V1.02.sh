#!/bin/bash
# paraacco 每日批次進件 V1.02(2026-09-22)
# V1.02:新增 ensure_mounted() 自動掛載網路磁碟(Scanner + ATLPAR_Bookkeeper 兩個 share),
#        解決 Mac mini 睡眠/重開後 SMB 掛載消失、腳本啟動即 ABORT 的問題。
#        主流程改用 caffeinate -i 包住,避免執行中途睡眠。
# V1.01:列檔失敗(macOS 隱私權限 EPERM)或複製驗證失敗時明確回報失敗,不再「0 筆 + 成功」。
# Bookkeeper_Scanner → POST acco-api /api/batch-import/documents → 複製到 00_原始文件/<日期>/
#
# 驗證三層:Cloudflare Access Service Token(邊緣)→ access-jwt.ts 白名單 → X-Local-Scanner-Token
#
# 環境變數(皆可選):
#   DRY_RUN=1        只列出會上傳的檔案,不上傳、不複製、不寫 manifest
#   LIMIT=N          本次最多處理 N 個新檔案(0 = 不限)
#   DELETE_SOURCE=1  上傳成功且複製檔 sha256 驗證一致後,刪除原始檔(預設 0 = 不刪)
#   SRC / DEST_ROOT  直接指定最終路徑(測試用)。一旦設定,會跳過 ensure_mounted 自動掛載,
#                    直接使用指定路徑(維持 V1.01 既有的測試覆寫行為)。
#   SHARE_HOST / SHARE_USER / SRC_SHARE / SRC_SUBPATH / DEST_SHARE / DEST_SUBPATH
#                    自動掛載用的 NAS 位址與 share 名稱,預設對應現行 192.168.20.91 上的
#                    Scanner、ATLPAR_Bookkeeper 兩個 share。
#   NET_WAIT_TRIES / MOUNT_TRIES  ensure_mounted 的網路探測 / 掛載重試次數。
# 路徑皆可用同名環境變數覆寫(測試用)。bash 3.2 相容(macOS 內建 /bin/bash)。
VERSION="V1.02"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 077

# 用 caffeinate -i 包住整個主流程(含 ensure_mounted 的網路等待、掛載重試),
# 避免 Mac mini 在批次進件跑到一半時進入睡眠。只重新 exec 一次,避免遞迴。
if [ -z "${PARAACCO_CAFFEINATED:-}" ]; then
  export PARAACCO_CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi

SHARE_HOST="${SHARE_HOST:-192.168.20.91}"
SHARE_USER="${SHARE_USER:-LSY}"
SRC_SHARE="${SRC_SHARE:-Scanner}"
SRC_SUBPATH="${SRC_SUBPATH:-Bookkeeper_Scanner}"
DEST_SHARE="${DEST_SHARE:-ATLPAR_Bookkeeper}"
DEST_SUBPATH="${DEST_SUBPATH:-Paraacco_公司財務系統/00_原始文件}"
NET_WAIT_TRIES="${NET_WAIT_TRIES:-6}"
MOUNT_TRIES="${MOUNT_TRIES:-4}"

SRC="${SRC:-}"
DEST_ROOT="${DEST_ROOT:-}"
REPO="${REPO:-$HOME/dev/paraacco}"
TOKEN_FILE="${TOKEN_FILE:-$REPO/.local-scanner-token}"
CF_ENV="${CF_ENV:-$HOME/.config/paraacco-batch/batch_ingest.env}"
MANIFEST="${MANIFEST:-$REPO/.batch-import-manifest.log}"
LOG_DIR="${LOG_DIR:-$REPO/logs}"
API="${API:-https://acco-api.parallelserver.org/api/batch-import/documents}"
LOCK="${LOCK:-/tmp/paraacco-batch-ingest.lock}"
DRY_RUN="${DRY_RUN:-0}"; LIMIT="${LIMIT:-0}"; DELETE_SOURCE="${DELETE_SOURCE:-0}"
# 開關檔:存在時強制試跑(給 launchd 觸發時用,launchd 無法臨時帶環境變數)
[ -f "$REPO/.batch-ingest-dry-run" ] && DRY_RUN=1

TODAY=$(date +%Y%m%d)
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/batch-ingest-$TODAY.log"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"paraacco 批次進件\"" >/dev/null 2>&1; }
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

# ---- ensure_mounted 相關函式 --------------------------------------------

# 判斷 share 是否「真的」以 smbfs 掛載(而非資料夾存在但未掛載的殘留空資料夾),
# 並處理 macOS 自動改名成 <share>-1 的情況:用 mount 輸出比對遠端 host/share,
# 不比對本機資料夾名稱。成功時把實際掛載點寫進全域變數 MOUNTPOINT。
is_share_mounted() {
  local share="$1" hostre line
  hostre=$(printf '%s' "$SHARE_HOST" | sed 's/\./\\./g')
  line=$(mount | grep -E "^//([^ @]+@)?${hostre}/${share} on /Volumes/[^ ]+ \(smbfs" | head -1)
  [ -n "$line" ] || return 1
  MOUNTPOINT=$(printf '%s\n' "$line" | sed -E 's#^.* on (/Volumes/[^ ]+) \(smbfs.*#\1#')
  [ -n "$MOUNTPOINT" ]
}

# 等待網路恢復:對 host:port 用 nc -z 探測,重試 N 次,間隔逐次拉長(2s,4s,8s...上限 60s)。
wait_for_network() {
  local host="$1" port="$2" tries="$3" i=1 delay=2
  while [ "$i" -le "$tries" ]; do
    if nc -z -G 5 "$host" "$port" >/dev/null 2>&1; then return 0; fi
    log "WAIT 網路未就緒($host:$port),第 $i/$tries 次,${delay}s 後重試"
    sleep "$delay"
    delay=$((delay * 2)); [ "$delay" -gt 60 ] && delay=60
    i=$((i+1))
  done
  return 1
}

# 用 osascript 的 mount volume 掛載,帳密走 Keychain(不寫明碼密碼)。
# with timeout 只能約束 AppleScript 本身等待 Finder 回應的時間,無法保證關閉系統
# 認證對話框;若 Keychain 帳密失效,仍可能卡住等待人工介入,這是 macOS 的已知限制。
attempt_mount() {
  local share="$1" out
  out=$(osascript <<APPLESCRIPT
with timeout of 25 seconds
  try
    mount volume "smb://${SHARE_USER}@${SHARE_HOST}/${share}"
    return "OK"
  on error errMsg number errNum
    return "ERR " & errNum & " " & errMsg
  end try
end timeout
APPLESCRIPT
  2>&1)
  case "$out" in
    OK) return 0 ;;
    *) log "WARN $share osascript mount 失敗:$out"; return 1 ;;
  esac
}

# 驗證掛載點可讀,readwrite 模式再驗證可寫(在指定子路徑 touch 暫存檔後刪除)。
verify_share_access() {
  local mp="$1" mode="$2" writesub="$3" testdir tf
  ls "$mp" >/dev/null 2>&1 || { log "WARN $mp 無法讀取(ls 失敗)"; return 1; }
  if [ "$mode" = "readwrite" ]; then
    testdir="$mp"; [ -n "$writesub" ] && testdir="$mp/$writesub"
    tf="$testdir/.paraacco_mount_writetest_$$"
    if ! ( : > "$tf" ) 2>/dev/null; then
      log "WARN $testdir 無法寫入(建立暫存檔失敗)"; return 1
    fi
    rm -f "$tf"
  fi
  return 0
}

# 確保 share 已掛載且可用:已掛載且驗證通過就直接回傳;否則等網路 → 掛載 → 驗證,
# 全部重試後仍失敗才回傳非 0(由呼叫端負責寫 ABORT log + 發通知)。
# $1=share名稱 $2=要寫入掛載點的變數名稱 $3=read|readwrite $4=readwrite時的驗證子路徑
ensure_mounted() {
  local share="$1" outvar="$2" mode="$3" writesub="$4" attempt delay

  if is_share_mounted "$share"; then
    if verify_share_access "$MOUNTPOINT" "$mode" "$writesub"; then
      eval "$outvar=\"\$MOUNTPOINT\""
      log "MOUNT_OK $share 已掛載於 $MOUNTPOINT(驗證通過)"
      return 0
    fi
    log "WARN $share 掛載點 $MOUNTPOINT 存在但驗證失敗,視為未掛載,嘗試重新掛載"
  fi

  if ! wait_for_network "$SHARE_HOST" 445 "$NET_WAIT_TRIES"; then
    log "MOUNT_FAIL $share 網路 $SHARE_HOST:445 逾時未恢復($NET_WAIT_TRIES 次)"
    return 1
  fi

  attempt=1
  while [ "$attempt" -le "$MOUNT_TRIES" ]; do
    log "MOUNT_TRY $share 第 $attempt/$MOUNT_TRIES 次"
    if attempt_mount "$share" && is_share_mounted "$share"; then
      if verify_share_access "$MOUNTPOINT" "$mode" "$writesub"; then
        eval "$outvar=\"\$MOUNTPOINT\""
        log "MOUNT_OK $share 掛載成功於 $MOUNTPOINT(第 $attempt 次,驗證通過)"
        return 0
      fi
      log "WARN $share 掛載後驗證失敗於 $MOUNTPOINT"
    fi
    attempt=$((attempt+1))
    delay=$((attempt*3))
    [ "$attempt" -le "$MOUNT_TRIES" ] && { log "MOUNT_RETRY $share ${delay}s 後重試掛載"; sleep "$delay"; }
  done

  log "MOUNT_FAIL $share 重試 $MOUNT_TRIES 次仍失敗"
  return 1
}

# ---------------------------------------------------------------------------

if ! mkdir "$LOCK" 2>/dev/null; then log "SKIP 另一個執行中($LOCK)"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rmdir "$LOCK" 2>/dev/null' EXIT

log "START $VERSION dry_run=$DRY_RUN limit=$LIMIT delete_source=$DELETE_SOURCE"
[ -f "$TOKEN_FILE" ] || { log "ABORT MISSING_TOKEN_FILE $TOKEN_FILE"; exit 1; }
[ -f "$CF_ENV" ]     || { log "ABORT MISSING_CF_ENV $CF_ENV"; exit 1; }

if [ -z "$SRC" ]; then
  if ! ensure_mounted "$SRC_SHARE" MP_SRC read; then
    log "ABORT 來源網路磁碟無法自動掛載: $SRC_SHARE ($SHARE_HOST)"
    notify "批次進件中止:來源磁碟 $SRC_SHARE 無法自動掛載"
    exit 1
  fi
  SRC="$MP_SRC/$SRC_SUBPATH"
fi
if [ -z "$DEST_ROOT" ]; then
  if ! ensure_mounted "$DEST_SHARE" MP_DEST readwrite "$DEST_SUBPATH"; then
    log "ABORT 目的地網路磁碟無法自動掛載: $DEST_SHARE ($SHARE_HOST)"
    notify "批次進件中止:目的地磁碟 $DEST_SHARE 無法自動掛載"
    exit 1
  fi
  DEST_ROOT="$MP_DEST/$DEST_SUBPATH"
fi

[ -d "$SRC" ]        || { log "ABORT 來源無法存取(未掛載、不存在或無權限): $SRC"; notify "批次進件中止:來源路徑無法存取"; exit 1; }
[ -d "$DEST_ROOT" ]  || { log "ABORT 目的地無法存取(未掛載、不存在或無權限): $DEST_ROOT"; notify "批次進件中止:目的地路徑無法存取"; exit 1; }
if ! ls "$SRC" >/dev/null 2>"$TMP/ls.err"; then log "ABORT 無權讀取來源(macOS 隱私權限?): $SRC :: $(head -c 200 "$TMP/ls.err" | tr '\n' ' ')"; notify "批次進件中止:來源路徑無讀取權限"; exit 1; fi
if ! ls "$DEST_ROOT" >/dev/null 2>"$TMP/ls.err"; then log "ABORT 無權讀取目的地(macOS 隱私權限?): $DEST_ROOT :: $(head -c 200 "$TMP/ls.err" | tr '\n' ' ')"; notify "批次進件中止:目的地路徑無讀取權限"; exit 1; fi

. "$CF_ENV"
if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
  log "ABORT CF_ENV 缺少 CF_ACCESS_CLIENT_ID 或 CF_ACCESS_CLIENT_SECRET"; exit 1
fi
SCANNER_TOKEN=$(cat "$TOKEN_FILE")
touch "$MANIFEST"

up=0; skip=0; fail=0; wait=0; warn=0; n=0
if ! find "$SRC" -type f \( -iname '*.pdf' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) ! -name '.*' -print0 > "$TMP/list" 2>"$TMP/find.err"; then
  log "ABORT 列出來源檔案失敗: $(head -c 300 "$TMP/find.err" | tr '\n' ' ')"; exit 1
fi
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
    warn=$((warn+1)); log "WARN 已上傳 $id,但複製/驗證失敗,原始檔保留: $f"
  fi
done < "$TMP/list"

log "END uploaded=$up skipped=$skip waiting=$wait failed=$fail warn=$warn"
[ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]
