@echo off
setlocal
cd /d "%~dp0"
title openCaption - installer

echo.
echo  openCaption - installer
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo  Installer exited with code %RC%.
  echo  Read the messages above, or open README-FIRST.txt.
) else (
  echo  Done.
)
echo.
pause
exit /b %RC%
