@echo off
setlocal
cd /d "%~dp0"
title Caption AI - uninstall

echo.
echo  Caption AI - uninstall
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo  Uninstall exited with code %RC%.
) else (
  echo  Done.
)
echo.
pause
exit /b %RC%
