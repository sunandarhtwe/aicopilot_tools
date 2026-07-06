@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title DAT Copilot Bridge - One-time Install

echo ===================================================
echo  DAT Copilot Bridge - One-time Extension Install
echo ===================================================
echo.
echo This packages the bridge as a .vsix and installs it into VS Code
echo PERMANENTLY, so it auto-starts every time VS Code opens — no need to
echo press F5 or open this folder manually ever again.
echo.
echo You only need to run this ONCE per PC (or again after you edit
echo extension.js / package.json).
echo.
echo Requires internet access the first time (to install the vsce packaging
echo tool) and VS Code's "code" command available in PATH.
echo.
pause

where code >nul 2>nul
if errorlevel 1 (
  echo [NOTICE] The "code" command was not found in PATH.
  echo In VS Code: Ctrl+Shift+P -^> "Shell Command: Install 'code' command in PATH", then re-run this file.
  echo.
  pause
  exit /b 1
)

where npx >nul 2>nul
if errorlevel 1 (
  echo [NOTICE] npx/npm not found. Please install Node.js LTS first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo [INFO] Packaging extension with vsce...
call npx --yes @vscode/vsce package --allow-missing-repository --skip-license
if errorlevel 1 (
  echo.
  echo [NOTICE] Packaging failed. Check the error above ^(internet/proxy access is required for this one-time step^).
  echo.
  pause
  exit /b 1
)

for %%f in (*.vsix) do set VSIX_FILE=%%f
if "%VSIX_FILE%"=="" (
  echo [NOTICE] No .vsix file was produced. Aborting.
  pause
  exit /b 1
)

echo [INFO] Installing %VSIX_FILE% into VS Code...
call code --install-extension "%VSIX_FILE%" --force
if errorlevel 1 (
  echo.
  echo [NOTICE] Install failed. See the error above.
  echo.
  pause
  exit /b 1
)

echo.
echo [SUCCESS] DAT Copilot Bridge is now installed and will auto-start whenever
echo           VS Code opens. You can close this window and use
echo           start_DAT_Copilot_Tool.bat as normal from now on.
echo.
pause
