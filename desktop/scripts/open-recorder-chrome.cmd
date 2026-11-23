@echo off
set "PROFILE=%TEMP%\ops-observe-profile"
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE%" --remote-debugging-port=9222 --remote-allow-origins=* --start-maximized https://creator.xiaohongshu.com/new/home https://mp.weixin.qq.com/
