@echo off
setlocal
cd /d "%~dp0"
title openCaption - uninstall

echo.
echo  openCaption - uninstall
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
