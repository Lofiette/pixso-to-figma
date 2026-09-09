@echo off
rem Double-click this, then press the button in the plugin window in Figma.
rem Leave this window open until the migration says it is done.
cd /d "%~dp0tools"
node run.mjs %*
echo.
echo This window can be closed.
pause
