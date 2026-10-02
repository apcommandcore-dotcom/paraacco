#!/bin/bash
# paraacco 每日批次進件 V1.03(2026-09-28)
# V1.03:原始檔只留 NAS(CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第四節 A)。
#        Bookkeeper_Scanner/* → 複製到 Paraacco_公司財務系統/00_收件/YYYYMMDD/ → 驗證 SHA-256
#        → POST /api/batch-import/documents-local(只登記路徑與 SHA-256,不傳檔案,R2 不收新檔)
#        → 把 NAS 上的檔案改名成 DOC-2026-xxxxxx.<ext>(登記時已用 {id} 樣板寫好最終路徑,
#          不用再打一次回寫端點)→ 依 DELETE_SOURCE 處理入口檔(預設保留)。
#        加密(要密碼才能開)的 PDF 不登記,複製到 90_無法處理/加密無解鎖版/ 並記 log。
#        改名失敗的檔案記在 PENDING_RENAMES,下次執行先補改名。
#        JSON 用 jq 組(檔名含逗號、分號、引號都安全;V1.02 的 curl -F 在逗號檔名會失敗)。
# V1.02:ensure_mounted() 自動掛載網路磁碟;caffeinate -i 避免睡眠。V1.01、V1.02 唯讀保留。
#
# 驗證:Cloudflare Access Service Token(邊緣)→ X-Local-Scanner-Token
#
# 環境變數(皆可選):
#   DRY_RUN=1        只列出會處理的檔案,不複製、不登記、不寫 manifest
#   LIMIT=N          本次最多處理 N 個新檔案(0 = 不限)
#   DELETE_SOURCE=1  登記成功且 NAS 複本 sha256 驗證一致後,刪除入口檔(預設 0 = 不刪)
#   SRC / MANAGED    直接指定入口資料夾 / 受管區根目錄(測試用,設定後跳過自動掛載)
#   SHARE_HOST / SHARE_USER / SRC_SHARE / SRC_SUBPATH / DEST_SHARE / MANAGED_SUBPATH
#   NET_WAIT_TRIES / MOUNT_TRIES
# bash 3.2 相容(macOS 內建 /bin/bash)。
VERSION="V1.03"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
umask 077

if [ -z "${PARAACCO_CAFFEINATED:-}" ]; then
  export PARAACCO_CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi

SHARE_HOST="${SHARE_HOST:-192.168.20.91}"
SHARE_USER="${SHARE_USER:-LSY}"
SRC_SHARE="${SRC_SHARE:-Scanner}"
SRC_SUBPATH="${SRC_SUBPATH:-Bookkeeper_Scanner}"
DEST_SHARE="${DEST_SHARE:-ATLPAR_Bookkeeper}"
# 受管區在 share 內的相對路徑,同時也是 local_path 的第一段(見 @paraacco/shared MANAGED_ROOT)。
MANAGED_SUBPATH="${MANAGED_SUBPATH:-Paraacco_公司財務系統}"
NET_WAIT_TRIES="${NET_WAIT_TRIES:-6}"
MOUNT_TRIES="${MOUNT_TRIES:-4}"

SRC="${SRC:-}"
MANAGED="${MANAGED:-}"
REPO="${REPO:-$HOME/dev/paraacco}"
TOKEN_FILE="${TOKEN_FILE:-$REPO/.local-scanner-token}"
CF_ENV="${CF_ENV:-$HOME/.config/paraacco-batch/batch_ingest.env}"
MANIFEST="${MANIFEST:-$REPO/.batch-import-manifest.log}"
ENC_MANIFEST="${ENC_MANIFEST:-$REPO/.batch-import-encrypted.log}"
PENDING_RENAMES="${PENDING_RENAMES:-$REPO/.batch-ingest-pending-renames.tsv}"
LOG_DIR="${LOG_DIR:-$REPO/logs}"
API="${API:-https://acco-api.parallelserver.org/api/batch-import/documents-local}"
LOCK="${LOCK:-/tmp/paraacco-batch-ingest.lock}"
DRY_RUN="${DRY_RUN:-0}"; LIMIT="${LIMIT:-0}"; DELETE_SOURCE="${DELETE_SOURCE:-0}"
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
command -v jq >/dev/null   || { log "ABORT 找不到 jq"; exit 1; }
command -v qpdf >/dev/null || { log "ABORT 找不到 qpdf(判斷加密 PDF 用,brew install qpdf)"; exit 1; }
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
if [ -z "$MANAGED" ]; then
  if ! ensure_mounted "$DEST_SHARE" MP_DEST readwrite "$MANAGED_SUBPATH"; then
    log "ABORT 目的地網路磁碟無法自動掛載: $DEST_SHARE ($SHARE_HOST)"
    notify "批次進件中止:目的地磁碟 $DEST_SHARE 無法自動掛載"
    exit 1
  fi
  MANAGED="$MP_DEST/$MANAGED_SUBPATH"
fi
REL_ROOT="$(basename "$MANAGED")"   # local_path 第一段,正式環境 = Paraacco_公司財務系統

[ -d "$SRC" ]     || { log "ABORT 來源無法存取: $SRC"; notify "批次進件中止:來源路徑無法存取"; exit 1; }
[ -d "$MANAGED" ] || { log "ABORT 受管區無法存取: $MANAGED"; notify "批次進件中止:受管區路徑無法存取"; exit 1; }
if ! ls "$SRC" >/dev/null 2>"$TMP/ls.err"; then log "ABORT 無權讀取來源(macOS 隱私權限?): $SRC :: $(head -c 200 "$TMP/ls.err" | tr '\n' ' ')"; notify "批次進件中止:來源路徑無讀取權限"; exit 1; fi

. "$CF_ENV"
if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
  log "ABORT CF_ENV 缺少 CF_ACCESS_CLIENT_ID 或 CF_ACCESS_CLIENT_SECRET"; exit 1
fi
SCANNER_TOKEN=$(cat "$TOKEN_FILE")
touch "$MANIFEST" "$ENC_MANIFEST" "$PENDING_RENAMES"

# 0 = 要密碼才能開(不登記);其他 = 可讀(沒加密,或只有 owner 密碼)。
# qpdf --requires-password:0=需要密碼、2=沒加密、3=加密但不需密碼。
requires_password() { qpdf --requires-password "$1" >/dev/null 2>&1; }

mime_of() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    pdf) echo application/pdf ;; jpg|jpeg) echo image/jpeg ;; png) echo image/png ;; *) echo application/octet-stream ;;
  esac
}

# 複製到目的資料夾(同名時加 sha 前 8 碼),驗證 sha256;成功時把目的路徑寫進全域變數 COPIED。
copy_verified() {
  local f="$1" dir="$2" h="$3" b t
  mkdir -p "$dir" || return 1
  b=$(basename "$f"); t="$dir/$b"
  [ -e "$t" ] && t="$dir/${b%.*}_${h:0:8}.${b##*.}"
  cp -p "$f" "$t" || return 1
  if [ "$(sha "$t")" != "$h" ]; then rm -f "$t"; return 1; fi
  COPIED="$t"
}

# ---- 先補上次改名失敗的檔案 --------------------------------------------------
if [ -s "$PENDING_RENAMES" ] && [ "$DRY_RUN" != "1" ]; then
  : > "$TMP/pending.new"
  while IFS="$(printf '\t')" read -r pid pfrom pto psha; do
    [ -n "$pid" ] || continue
    if [ -e "$MANAGED/${pto#*/}" ] && [ "$(sha "$MANAGED/${pto#*/}")" = "$psha" ]; then log "RENAME_OK(已存在)$pid $pto"; continue; fi
    if [ -e "$MANAGED/${pfrom#*/}" ] && mv -n "$MANAGED/${pfrom#*/}" "$MANAGED/${pto#*/}" && [ "$(sha "$MANAGED/${pto#*/}")" = "$psha" ]; then
      log "RENAME_OK(補做)$pid $pfrom -> $pto"
    else
      log "WARN 仍無法改名 $pid $pfrom -> $pto"; printf '%s\t%s\t%s\t%s\n' "$pid" "$pfrom" "$pto" "$psha" >> "$TMP/pending.new"
    fi
  done < "$PENDING_RENAMES"
  cp "$TMP/pending.new" "$PENDING_RENAMES"
fi

up=0; skip=0; fail=0; wait=0; warn=0; enc=0; n=0
if ! find "$SRC" -type f \( -iname '*.pdf' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) ! -name '.*' -print0 > "$TMP/list" 2>"$TMP/find.err"; then
  log "ABORT 列出來源檔案失敗: $(head -c 300 "$TMP/find.err" | tr '\n' ' ')"; exit 1
fi
INBOX_REL="$REL_ROOT/00_收件/$TODAY"
INBOX="$MANAGED/00_收件/$TODAY"
ENC_DIR="$MANAGED/90_無法處理/加密無解鎖版"

while IFS= read -r -d '' f; do
  if [ "$LIMIT" -gt 0 ] && [ "$n" -ge "$LIMIT" ]; then break; fi
  mt=$(mtime "$f" 2>/dev/null)
  case "$mt" in ''|*[!0-9]*) fail=$((fail+1)); log "FAIL 無法取得修改時間: $f"; continue;; esac
  age=$(( $(date +%s) - mt ))
  if [ "$age" -lt 120 ]; then wait=$((wait+1)); log "WAIT 剛寫入 ${age}s,下次處理: $f"; continue; fi
  h=$(sha "$f" 2>/dev/null)
  case "$h" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) fail=$((fail+1)); log "FAIL 無法計算 sha256: $f"; continue;; esac
  if cut -f1 "$MANIFEST" | grep -qx "$h" || cut -f1 "$ENC_MANIFEST" | grep -qx "$h" || grep -qx "$h" "$TMP/seen" 2>/dev/null; then
    skip=$((skip+1)); continue
  fi
  echo "$h" >> "$TMP/seen"
  n=$((n+1))
  b=$(basename "$f"); ext="${b##*.}"; [ "$ext" = "$b" ] && ext=bin
  ext=$(printf '%s' "$ext" | tr 'A-Z' 'a-z')

  # 加密 PDF:不登記,放 90_無法處理/加密無解鎖版/
  if [ "$ext" = "pdf" ] && requires_password "$f"; then
    enc=$((enc+1))
    if [ "$DRY_RUN" = "1" ]; then log "DRY 加密 PDF,會放 90_無法處理/加密無解鎖版/: $f"; continue; fi
    if copy_verified "$f" "$ENC_DIR" "$h"; then
      printf '%s\t%s\t%s\t%s\n' "$h" "ENCRYPTED" "$(date '+%Y-%m-%dT%H:%M:%S')" "$f" >> "$ENC_MANIFEST"
      log "ENC 加密 PDF 未登記,已複製到 $COPIED"
      if [ "$DELETE_SOURCE" = "1" ]; then rm -f "$f" && log "DEL 已刪除入口檔: $f"; fi
    else
      warn=$((warn+1)); log "WARN 加密 PDF 複製/驗證失敗,入口檔保留: $f"
    fi
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then log "DRY 會登記: $f -> $INBOX_REL/DOC-….$ext"; continue; fi

  if ! copy_verified "$f" "$INBOX" "$h"; then
    fail=$((fail+1)); log "FAIL 複製到 00_收件 或 SHA-256 驗證失敗,未登記: $f"; continue
  fi
  copied="$COPIED"; copied_rel="$INBOX_REL/$(basename "$copied")"
  size=$(stat -f %z "$copied" 2>/dev/null || stat -c %s "$copied")

  jq -n --arg fileName "$b" --argjson byteSize "$size" --arg mimeType "$(mime_of "$ext")" --arg sha256 "$h" \
     --arg localPath "$INBOX_REL/{id}.$ext" '{fileName:$fileName, byteSize:$byteSize, mimeType:$mimeType, sha256:$sha256, localPath:$localPath}' > "$TMP/body.json"
  rm -f "$TMP/resp"
  code=$(curl -s -o "$TMP/resp" -w '%{http_code}' --max-time 60 -X POST "$API" \
    -H "Content-Type: application/json" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H "X-Local-Scanner-Token: $SCANNER_TOKEN" \
    --data-binary @"$TMP/body.json")
  if [ "$code" != "201" ]; then
    rm -f "$copied"
    fail=$((fail+1)); log "FAIL http=$code $f :: $(head -c 200 "$TMP/resp" 2>/dev/null | tr '\n' ' ')(已移除 00_收件 複本)"; continue
  fi
  id=$(jq -r '.id // empty' "$TMP/resp"); lp=$(jq -r '.localPath // empty' "$TMP/resp")
  if [ -z "$id" ] || [ -z "$lp" ]; then warn=$((warn+1)); log "WARN 登記成功但回應缺 id/localPath: $(head -c 200 "$TMP/resp")"; continue; fi
  printf '%s\t%s\t%s\t%s\n' "$h" "$id" "$(date '+%Y-%m-%dT%H:%M:%S')" "$f" >> "$MANIFEST"
  up=$((up+1))

  target="$MANAGED/${lp#*/}"
  if mv -n "$copied" "$target" && [ -e "$target" ] && [ "$(sha "$target")" = "$h" ]; then
    log "OK $id $f -> $lp"
    if [ "$DELETE_SOURCE" = "1" ]; then rm -f "$f" && log "DEL 已刪除入口檔: $f"; fi
  else
    warn=$((warn+1)); printf '%s\t%s\t%s\t%s\n' "$id" "$copied_rel" "$lp" "$h" >> "$PENDING_RENAMES"
    log "WARN 已登記 $id,但改名失敗($copied_rel -> $lp),下次執行補做;入口檔保留: $f"
  fi
  sleep 0.2
done < "$TMP/list"

log "END registered=$up encrypted=$enc skipped=$skip waiting=$wait failed=$fail warn=$warn"
[ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]
