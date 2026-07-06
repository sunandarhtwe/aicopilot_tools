@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title DAT AI Test Case Generator - Copilot Bridge v4.0

echo ===============================================
echo  DAT AI Test Case Generator - Copilot Bridge v4.0
echo ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [NOTICE] Node.js is not installed on this PC.
  echo Please install Node.js LTS first, then run this file again.
  echo Download: https://nodejs.org/
  echo.
  pause
  exit /b 0
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [NOTICE] npm is not available. Please reinstall Node.js LTS with npm included.
  echo.
  pause
  exit /b 0
)

if not exist ".env" (
  echo COPILOT_BRIDGE_URL=http://127.0.0.1:4321/generate > .env
  echo COPILOT_MODEL_FAMILY= >> .env
  echo COPILOT_TIMEOUT_MS=120000 >> .env
  echo MAX_TEST_CASES=120 >> .env
  echo [INFO] .env file was created with default Copilot Bridge settings.
  echo.
)

if not exist "node_modules" (
  echo [INFO] Installing required packages. Please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo [NOTICE] npm install did not complete successfully.
    echo Please check internet/proxy settings or run: npm install
    echo.
    pause
    exit /b 0
  )
)

REM --- Step 1: make sure DAT Copilot Bridge is running (auto-launch VS Code) ---
set "VSCODE_PID="
set "BRIDGE_WAS_ALREADY_RUNNING=0"
call :CheckBridgeHealth
if "%BRIDGE_ALIVE%"=="1" (
  echo [INFO] DAT Copilot Bridge is already running.
  set "BRIDGE_WAS_ALREADY_RUNNING=1"
) else (
  call :LaunchBridgeIfPossible
)

REM --- Step 2: resolve a free port for this web server ---
set "PORT=3001"
:CHECKPORT
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  set /a PORT+=1
  goto CHECKPORT
)

REM --- Step 3: tell the bridge which port to watch (best-effort) ---
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:4321/register-node-port' -Method Post -Body (@{port=%PORT%} | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 3 | Out-Null } catch {}" >nul 2>nul

echo [INFO] Starting server on port %PORT% ...
start "" "http://localhost:%PORT%"
node server.js

echo.
echo [INFO] Server stopped.

REM --- Step 4: best-effort cleanup if we started VS Code ourselves ---
REM (The Node server also tells the bridge to quit directly on a clean exit —
REM  this is a backup in case that notification didn't get through, and the
REM  bridge's own watchdog is a further backup for an abrupt window close.)
if not "%VSCODE_PID%"=="" if "%BRIDGE_WAS_ALREADY_RUNNING%"=="0" (
  echo [INFO] Closing DAT Copilot Bridge / VS Code that this script started...
  taskkill /PID %VSCODE_PID% /T /F >nul 2>nul
)

pause
exit /b 0

REM =============================================================================
REM Subroutines (kept outside any parenthesized block — GOTO/labels used inside
REM parenthesized IF blocks are unreliable in cmd.exe, so anything looping or
REM branching lives down here and is invoked with CALL instead).
REM =============================================================================

:CheckBridgeHealth
REM Sets BRIDGE_ALIVE to 1 or 0.
set "BRIDGE_ALIVE=0"
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:4321/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 set "BRIDGE_ALIVE=1"
goto :EOF

:LaunchBridgeIfPossible
where code >nul 2>nul
if errorlevel 1 (
  echo [NOTICE] VS Code's "code" command was not found in PATH.
  echo          DAT Copilot Bridge cannot be auto-started.
  echo          Either add "code" to PATH ^(VS Code: Ctrl+Shift+P -^> "Shell Command: Install 'code' command in PATH"^)
  echo          and run copilot-bridge\install-extension.bat once, or start VS Code manually.
  echo          Continuing with document-based fallback generation only.
  echo.
  goto :EOF
)

echo [INFO] Starting VS Code with DAT Copilot Bridge ^(minimized^)...
set "DAT_BRIDGE_DIR=%~dp0copilot-bridge"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Start-Process -FilePath 'code' -ArgumentList @('--new-window', $env:DAT_BRIDGE_DIR) -WindowStyle Minimized -PassThru).Id"`) do set "VSCODE_PID=%%p"

echo [INFO] Waiting for DAT Copilot Bridge to come online ^(up to 30s^)...
set "WAITED=0"
:WAITBRIDGE_LOOP
call :CheckBridgeHealth
if "%BRIDGE_ALIVE%"=="1" (
  echo [INFO] DAT Copilot Bridge is online.
  echo.
  goto :EOF
)
set /a WAITED+=2
if %WAITED% GEQ 30 (
  echo [NOTICE] DAT Copilot Bridge did not respond within 30s.
  echo          If this is the first time, VS Code may still be loading the extension —
  echo          the web tool will retry automatically once you generate a test case.
  echo          Falling back to document-based generation until then.
  echo.
  goto :EOF
)
timeout /t 2 /nobreak >nul
goto WAITBRIDGE_LOOP
