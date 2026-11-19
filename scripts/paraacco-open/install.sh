#!/bin/bash
# ParaaccoOpen 安裝 V1.0(2026-11-19)
# 把 ParaaccoOpen_V<最新>.applescript 編成 ~/Applications/ParaaccoOpen.app,
# 註冊 paraacco-open:// 網址協定,讓 paraacco 網頁的 NAS 路徑可直接點開 PDF。
# 用法:bash ~/dev/paraacco/scripts/paraacco-open/install.sh
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(ls "$HERE"/ParaaccoOpen_V*.applescript | sort -V | tail -1)"
APP="$HOME/Applications/ParaaccoOpen.app"
PLIST="$APP/Contents/Info.plist"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

echo "來源:$SRC"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" "$SRC"

/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string org.parallelserver.paraacco.open" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier org.parallelserver.paraacco.open" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy \
  -c "Add :CFBundleURLTypes array" \
  -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string Paraacco NAS file" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string paraacco-open" \
  "$PLIST"

# Info.plist 改過後重新簽章(ad-hoc),否則 Gatekeeper 會拒絕啟動
codesign --force --deep --sign - "$APP"
"$LSREG" -f "$APP"
echo "完成:$APP"
echo "測試:open 'paraacco-open://open/ATLPAR_Bookkeeper/'  (應跳出「路徑」或「找不到檔案」提示,代表協定已接上)"
