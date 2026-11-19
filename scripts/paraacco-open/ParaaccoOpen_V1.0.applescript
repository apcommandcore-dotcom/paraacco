-- ParaaccoOpen V1.0(2026-11-19)
-- 接手 paraacco 網頁上的 paraacco-open://open/<share>/<相對路徑> 連結:
--   1. 解碼路徑,拒絕含 .. 的路徑與白名單外的 share
--   2. /Volumes/<share> 沒掛載就用 Finder 鑰匙圈帳密掛載 smb://192.168.20.91/<share>
--   3. 用 Google Chrome 開啟該檔(Chrome 內建 PDF 檢視器)
-- 安裝:scripts/paraacco-open/install.sh

property nasHost : "192.168.20.91"
property allowedShares : {"ATLPAR_Bookkeeper"}
property chromeApp : "Google Chrome"

on run
	display dialog "ParaaccoOpen 已安裝。在 paraacco 網頁點 NAS 路徑即可用 Chrome 開啟 PDF。" buttons {"好"} default button 1 with title "ParaaccoOpen"
end run

on open location theURL
	set prefix to "paraacco-open://open/"
	if theURL does not start with prefix then
		my fail("不認得的連結:" & theURL)
		return
	end if
	set encodedPath to text ((length of prefix) + 1) thru -1 of theURL
	-- 去掉 ?query 或 #fragment
	set AppleScript's text item delimiters to {"?", "#"}
	set encodedPath to text item 1 of encodedPath
	set AppleScript's text item delimiters to ""
	-- URL 解碼(perl 逐 byte 還原,UTF-8 中文檔名可正確處理)
	set relPath to do shell script "/usr/bin/printf '%s' " & quoted form of encodedPath & " | /usr/bin/perl -pe 's/%([0-9A-Fa-f]{2})/chr(hex($1))/ge'"
	if relPath contains "/../" or relPath starts with "../" or relPath ends with "/.." or relPath is ".." then
		my fail("路徑不合法:" & relPath)
		return
	end if
	set AppleScript's text item delimiters to "/"
	set shareName to text item 1 of relPath
	set AppleScript's text item delimiters to ""
	if allowedShares does not contain shareName then
		my fail("不允許的 NAS 共用資料夾:" & shareName)
		return
	end if
	set volRoot to "/Volumes/" & shareName
	if not my isDir(volRoot) then
		try
			mount volume "smb://" & nasHost & "/" & shareName
		on error errMsg
			my fail("無法掛載 smb://" & nasHost & "/" & shareName & return & errMsg)
			return
		end try
		-- 掛載完成前稍等
		repeat 20 times
			if my isDir(volRoot) then exit repeat
			delay 0.25
		end repeat
	end if
	set fullPath to "/Volumes/" & relPath
	try
		do shell script "/bin/test -f " & quoted form of fullPath
	on error
		my fail("找不到檔案(可能已被搬移或改名):" & return & fullPath)
		return
	end try
	do shell script "/usr/bin/open -a " & quoted form of chromeApp & " " & quoted form of fullPath
end open location

on isDir(p)
	try
		do shell script "/bin/test -d " & quoted form of p
		return true
	on error
		return false
	end try
end isDir

on fail(msg)
	display dialog msg buttons {"好"} default button 1 with title "ParaaccoOpen" with icon caution
end fail
