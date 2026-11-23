@echo off
setlocal
set "T3_DIR=%LOCALAPPDATA%\Programs\t3code"
set "T3_EXE="
for %%F in ("%T3_DIR%\T3 Code*.exe") do set "T3_EXE=%%~fF"
if not defined T3_EXE (
  echo T3 Code executable not found in "%T3_DIR%".
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%T3_EXE%" "%~dp0tray-patch.cjs" "%T3_DIR%\resources\app.asar" %*
pause
