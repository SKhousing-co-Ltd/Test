@echo off
setlocal
cd /d "%~dp0"
"%ProgramFiles%\nodejs\node.exe" "%~dp0node_modules\vite\bin\vite.js" --host 127.0.0.1 --open /Test/
pause
