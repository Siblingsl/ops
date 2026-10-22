@echo off
setlocal
pushd "%~dp0.."
call pnpm start
set "exitCode=%ERRORLEVEL%"
popd
if not "%exitCode%"=="0" pause
exit /b %exitCode%
