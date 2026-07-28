@echo off
set "PYTHON=C:\Users\%USERNAME%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
"%PYTHON%" "%~dp0tools\contract_plan_importer.py" serve
